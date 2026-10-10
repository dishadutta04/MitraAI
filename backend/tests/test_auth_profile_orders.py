import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import headers, make_token

PROFILE = {
    "name": "Kamla Devi",
    "age": 72,
    "phone": "+91 98765 43210",
    "address": "12 MG Road, Pune",
    "language": "hinglish",
    "preferred_stores": ["zepto"],
    "payment_method": "upi_on_delivery",
    "conditions": ["diabetes"],
    "allergies": ["peanut"],
    "medications": ["metformin"],
    "diet_notes": "Low sugar",
    "family_contacts": [{"name": "Ravi", "relation": "Son", "phone": "+91 90000 00000"}],
    "voice": {"voice_language": "hi-IN", "script": "devanagari", "read_aloud": True},
    "onboarding_completed": True,
}


def test_requires_sign_in(client):
    assert client.get("/api/v1/profile/me").status_code == 401
    assert client.post("/api/v1/orders/start", json={"message": "2 oats"}).status_code == 401


def test_rejects_token_from_another_issuer(client):
    bad = make_token("user_x", issuer="https://evil.example.com")
    assert client.get("/api/v1/profile/me", headers={"Authorization": f"Bearer {bad}"}).status_code == 401


def test_rejects_token_for_another_site(client):
    bad = make_token("user_x", azp="https://other-site.com")
    assert client.get("/api/v1/profile/me", headers={"Authorization": f"Bearer {bad}"}).status_code == 401


def test_new_user_has_no_profile_until_onboarding(client):
    assert client.get("/api/v1/profile/me", headers=headers("user_new")).status_code == 404
    res = client.post("/api/v1/orders/start", json={"message": "2 oats"}, headers=headers("user_new"))
    assert res.status_code == 409


def test_profile_round_trip(client):
    res = client.put("/api/v1/profile/me", json=PROFILE, headers=headers("user_a"))
    assert res.status_code == 200, res.text
    got = client.get("/api/v1/profile/me", headers=headers("user_a")).json()
    assert got["id"] == "user_a"
    assert got["family_contacts"][0]["name"] == "Ravi"
    assert got["voice"]["script"] == "devanagari"

    updated = client.put("/api/v1/profile/me", json={**PROFILE, "age": 73}, headers=headers("user_a")).json()
    assert updated["age"] == 73


def test_order_uses_own_health_profile_and_is_private(client):
    client.put("/api/v1/profile/me", json=PROFILE, headers=headers("user_b"))
    start = client.post("/api/v1/orders/start", json={"message": "1 kg cheeni aur peanut"}, headers=headers("user_b"))
    assert start.status_code == 200, start.text
    data = start.json()
    warnings = " ".join(data["state"]["guardrail"]["warnings"])
    assert "sugar" in warnings.lower()
    assert "allergy" in warnings.lower()

    # Another user can't approve this order.
    stranger = client.post(f"/api/v1/orders/{data['thread_id']}/resume", json={"approved": True}, headers=headers("user_c"))
    assert stranger.status_code == 404

    done = client.post(
        f"/api/v1/orders/{data['thread_id']}/resume",
        json={"approved": True, "payment_method": "cod"},
        headers=headers("user_b"),
    ).json()
    assert done["status"] == "completed"

    history = client.get("/api/v1/orders/history", headers=headers("user_b")).json()
    assert history[0]["thread_id"] == data["thread_id"]
    assert history[0]["payment_method"] == "cod"
    assert history[0]["request_text"] == "1 kg cheeni aur peanut"
    assert client.get("/api/v1/orders/history", headers=headers("user_c")).json() == []


def test_event_stream_is_owner_only(client):
    client.put("/api/v1/profile/me", json=PROFILE, headers=headers("user_d"))
    tid = client.post("/api/v1/orders/start", json={"message": "2 packet oats"}, headers=headers("user_d")).json()["thread_id"]

    with client.websocket_connect(f"/ws/events/{tid}?token={make_token('user_d')}") as ws:
        # Redis is unreachable in tests, so the owner gets the "live stream limited" notice.
        assert ws.receive_json()["event"] == "ws_warning"

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/events/{tid}?token={make_token('user_e')}") as ws:
            ws.receive_json()


def test_profile_needs_a_valid_mobile_number(client):
    for bad in ["", "123", "abcdefghij"]:
        res = client.put("/api/v1/profile/me", json={**PROFILE, "phone": bad}, headers=headers("user_m"))
        assert res.status_code == 422, bad
    saved = client.put("/api/v1/profile/me", json={**PROFILE, "phone": "98765 43210"}, headers=headers("user_m")).json()
    assert saved["phone"] == "+919876543210"  # stored in one format, ready for SMS
