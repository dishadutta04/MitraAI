"""Razorpay: create an order for the server-computed amount, verify checkout signatures, refund."""
from __future__ import annotations

import hashlib
import hmac

import httpx

from app.core.config import settings

API = "https://api.razorpay.com/v1"


class PaymentError(Exception):
    pass


def online_enabled() -> bool:
    return bool(settings.razorpay_key_id and settings.razorpay_key_secret)


def _auth() -> tuple[str, str]:
    if not online_enabled():
        raise PaymentError("Online payment isn't set up (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)")
    return settings.razorpay_key_id, settings.razorpay_key_secret  # type: ignore[return-value]


def create_order(amount_paise: int, receipt: str, notes: dict[str, str]) -> dict:
    try:
        res = httpx.post(
            f"{API}/orders",
            auth=_auth(),
            json={"amount": amount_paise, "currency": "INR", "receipt": receipt[:40], "notes": notes},
            timeout=15,
        )
    except httpx.HTTPError as exc:
        raise PaymentError(f"Couldn't reach Razorpay: {exc}") from exc
    if res.status_code >= 300:
        raise PaymentError(f"Razorpay refused the order ({res.status_code}): {res.text[:200]}")
    return res.json()


def signature_valid(order_id: str, payment_id: str, signature: str) -> bool:
    """Razorpay signs "order_id|payment_id" with the key secret (HMAC-SHA256)."""
    _, secret = _auth()
    expected = hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


def refund(payment_id: str, amount_paise: int) -> bool:
    try:
        res = httpx.post(f"{API}/payments/{payment_id}/refund", auth=_auth(), json={"amount": amount_paise}, timeout=15)
    except (httpx.HTTPError, PaymentError):
        return False
    return res.status_code < 300
