"""Order alerts by email (Resend) and SMS (Twilio) to the user and their family contacts.

A channel without keys reports "not_configured"; a failed send never affects the order itself.
"""
from __future__ import annotations

import re

import httpx

from app.core.config import settings
from app.schemas import AlertResult, UserProfile


def email_enabled() -> bool:
    return bool(settings.resend_api_key)


def sms_enabled() -> bool:
    return bool(settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_from_number)


def normalize_phone(raw: str) -> str | None:
    """E.164 for Twilio; bare 10-digit numbers are taken as Indian (+91)."""
    digits = re.sub(r"[^\d+]", "", raw or "")
    if not digits:
        return None
    if digits.startswith("+"):
        return digits if 8 <= len(digits) <= 16 else None
    if digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    if len(digits) == 10:
        return f"+91{digits}"
    if len(digits) == 12 and digits.startswith("91"):
        return f"+{digits}"
    return None


def send_email(to: str, subject: str, text: str) -> tuple[str, str | None]:
    if not email_enabled():
        return "not_configured", None
    try:
        res = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={"from": settings.alert_email_from, "to": [to], "subject": subject, "text": text},
            timeout=10,
        )
    except httpx.HTTPError as exc:
        return "failed", str(exc)[:200]
    return ("sent", None) if res.status_code < 300 else ("failed", res.text[:200])


def send_sms(to: str, body: str) -> tuple[str, str | None]:
    if not sms_enabled():
        return "not_configured", None
    try:
        res = httpx.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Messages.json",
            auth=(settings.twilio_account_sid, settings.twilio_auth_token),  # type: ignore[arg-type]
            data={"From": settings.twilio_from_number, "To": to, "Body": body},
            timeout=10,
        )
    except httpx.HTTPError as exc:
        return "failed", str(exc)[:200]
    return ("sent", None) if res.status_code < 300 else ("failed", res.text[:200])


def send_order_alerts(profile: UserProfile, summary: str, total: int, payment: str, eta: int) -> list[AlertResult]:
    """Tells the user, and (if they chose so) their family, that an order was placed."""
    first = profile.name.split(" ")[0] if profile.name else "Your family member"
    recipients: list[tuple[str, str, str]] = [("you", profile.phone, profile.email)]
    if profile.alerts.notify_family:
        recipients += [(c.name, c.phone, c.email) for c in profile.family_contacts]

    results: list[AlertResult] = []
    for who, phone, email in recipients:
        mine = who == "you"
        sms_text = (
            f"Mitra AI: your order is placed. {summary}. Total Rs {total} ({payment}). Arrives in ~{eta} min."
            if mine
            else f"Mitra AI: {first} just ordered {summary}. Total Rs {total} ({payment}). Arrives in ~{eta} min."
        )
        if profile.alerts.sms and (number := normalize_phone(phone)):
            status, error = send_sms(number, sms_text)
            results.append(AlertResult(channel="sms", to=number, who=who, status=status, error=error))
        if profile.alerts.email and email and "@" in email:
            subject = "Your Mitra order is placed" if mine else f"{first} placed an order with Mitra"
            body = (
                f"{'Hello ' + first if mine else 'Hello ' + who},\n\n"
                f"{'Your' if mine else first + chr(39) + 's'} order has been placed:\n  {summary}\n\n"
                f"Total: Rs {total}\nPayment: {payment}\nExpected in about {eta} minutes.\n"
                f"Deliver to: {profile.address or 'address on file'}\n\n— Mitra AI"
            )
            status, error = send_email(email.strip(), subject, body)
            results.append(AlertResult(channel="email", to=email.strip(), who=who, status=status, error=error))
    return results
