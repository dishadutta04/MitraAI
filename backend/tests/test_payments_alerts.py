import hashlib
import hmac
import uuid

import pytest

from app.core.config import settings
from app.services import alerts, payments
from conftest import headers
from test_auth_profile_orders import PROFILE

SECRET = "test_secret_123"


@pytest.fixture
def razorpay(monkeypatch):
    """Razorpay in test mode without the network: records orders and refunds."""
    monkeypatch.setattr(settings, "razorpay_key_id", "rzp_test_abc")
    monkeypatch.setattr(settings, "razorpay_key_secret", SECRET)
    calls = {"orders": [], "refunds": []}

    def create_order(amount_paise, receipt, notes):
        calls["orders"].append(amount_paise)
        return {"id": f"order_{uuid.uuid4().hex[:14]}", "amount": amount_paise}

    monkeypatch.setattr(payments, "create_order", create_order)
    monkeypatch.setattr(payments, "refund", lambda pid, amt: calls["refunds"].append((pid, amt)) or True)
    return calls


@pytest.fixture
def sent(monkeypatch):
    """Captures alerts instead of sending them; both channels count as configured."""
    out = []
    monkeypatch.setattr(alerts, "send_sms", lambda to, body: out.append(("sms", to, body)) or ("sent", None))
    monkeypatch.setattr(alerts, "send_email", lambda to, subj, body: out.append(("email", to, subj)) or ("sent", None))
    return out


def sign(order_id, payment_id):
    return hmac.new(SECRET.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()


def start(client, user, message="2 packet oats"):
    client.put("/api/v1/profile/me", json={**PROFILE, "allergies": [], "email": "kamla@example.com"}, headers=headers(user))
    data = client.post("/api/v1/orders/start", json={"message": message}, headers=headers(user)).json()
    return data["thread_id"], data["confirmation_payload"]["lines"]


def test_payment_config_reports_razorpay(client, razorpay):
    cfg = client.get("/api/v1/orders/payment-config", headers=headers("p0")).json()
    assert cfg == {"online_enabled": True, "key_id": "rzp_test_abc"}


def test_online_payment_amount_comes_from_server_and_is_verified(client, razorpay, sent):
    tid, lines = start(client, "p1")
    pick = 1  # second option for the first line
    expected = lines[0]["options"][pick]["unit_price"] * lines[0]["quantity"] * 100

    pay = client.post(f"/api/v1/orders/{tid}/payment", json={"selections": {"0": pick}}, headers=headers("p1")).json()
    assert pay["amount_paise"] == expected == razorpay["orders"][-1]

    # A forged signature is refused and nothing is bought.
    bad = client.post(
        f"/api/v1/orders/{tid}/resume",
        json={"approved": True, "payment_method": "online", "razorpay_order_id": pay["razorpay_order_id"],
              "razorpay_payment_id": "pay_X", "razorpay_signature": "forged"},
        headers=headers("p1"),
    )
    assert bad.status_code == 400

    # Real signature, but the request now claims the cheaper option: the paid-for pick is what's bought.
    done = client.post(
        f"/api/v1/orders/{tid}/resume",
        json={"approved": True, "payment_method": "online", "selections": {"0": 0},
              "razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": "pay_X",
              "razorpay_signature": sign(pay["razorpay_order_id"], "pay_X")},
        headers=headers("p1"),
    ).json()
    assert done["status"] == "completed"
    history = client.get("/api/v1/orders/history", headers=headers("p1")).json()[0]
    assert history["payment_method"] == "online"
    assert history["total"] * 100 == expected

    # Paying again for the same order is refused.
    again = client.post(f"/api/v1/orders/{tid}/payment", json={"selections": {}}, headers=headers("p1"))
    assert again.status_code == 409


def test_other_users_cannot_start_payment(client, razorpay):
    tid, _ = start(client, "p2")
    assert client.post(f"/api/v1/orders/{tid}/payment", json={}, headers=headers("p3")).status_code == 404


def test_failed_purchase_after_payment_is_refunded(client, razorpay, sent, monkeypatch):
    from app.agents import nodes

    tid, _ = start(client, "p4")
    pay = client.post(f"/api/v1/orders/{tid}/payment", json={}, headers=headers("p4")).json()

    def broken_store(**_):
        raise RuntimeError("vendor down")

    monkeypatch.setattr(nodes, "create_order", broken_store)
    monkeypatch.setattr(nodes.time, "sleep", lambda _s: None)
    done = client.post(
        f"/api/v1/orders/{tid}/resume",
        json={"approved": True, "payment_method": "online", "razorpay_order_id": pay["razorpay_order_id"],
              "razorpay_payment_id": "pay_R", "razorpay_signature": sign(pay["razorpay_order_id"], "pay_R")},
        headers=headers("p4"),
    ).json()
    assert razorpay["refunds"] == [("pay_R", pay["amount_paise"])]
    assert "refunded" in done["message"]


def test_alerts_reach_user_and_family(client, sent):
    tid, _ = start(client, "p5")
    done = client.post(f"/api/v1/orders/{tid}/resume", json={"approved": True, "payment_method": "cod"}, headers=headers("p5")).json()
    channels = {(c, to) for c, to, _ in sent}
    assert ("sms", "+919876543210") in channels  # user's phone, normalised to E.164
    assert ("sms", "+919000000000") in channels  # family contact Ravi
    assert ("email", "kamla@example.com") in channels
    assert "Ravi" in done["message"]
    statuses = done["state"]["notification"]["alerts"]
    assert all(a["status"] == "sent" for a in statuses)


def test_alerts_respect_settings(client, sent):
    client.put(
        "/api/v1/profile/me",
        json={**PROFILE, "allergies": [], "alerts": {"sms": False, "email": True, "notify_family": False}},
        headers=headers("p6"),
    )
    tid = client.post("/api/v1/orders/start", json={"message": "2 packet oats"}, headers=headers("p6")).json()["thread_id"]
    client.post(f"/api/v1/orders/{tid}/resume", json={"approved": True}, headers=headers("p6"))
    assert sent == []  # SMS off, family off, and this profile has no email


@pytest.mark.parametrize(
    "raw, expected",
    [("98765 43210", "+919876543210"), ("+91 98765-43210", "+919876543210"), ("09876543210", "+919876543210"),
     ("919876543210", "+919876543210"), ("+14155550100", "+14155550100"), ("123", None), ("", None)],
)
def test_phone_normalisation(raw, expected):
    assert alerts.normalize_phone(raw) == expected
