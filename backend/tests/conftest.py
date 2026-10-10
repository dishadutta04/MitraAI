import os
import sys
import tempfile
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_db = Path(tempfile.mkdtemp()) / "test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_db}"
os.environ["CLERK_ISSUER"] = "https://test.clerk.accounts.dev"
os.environ["REDIS_URL"] = "redis://127.0.0.1:1/0"  # unreachable: the event bus degrades quietly

from fastapi.testclient import TestClient  # noqa: E402

from app.core import auth  # noqa: E402
from app.main import app  # noqa: E402

_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeJwks:
    def get_signing_key_from_jwt(self, _token):
        return jwt.PyJWK.from_dict({**jwt.algorithms.RSAAlgorithm.to_jwk(_key.public_key(), as_dict=True), "alg": "RS256"})


@pytest.fixture(autouse=True)
def fake_clerk(monkeypatch):
    monkeypatch.setattr(auth, "_jwks_client", lambda _issuer: _FakeJwks())


def make_token(user_id: str, issuer: str = "https://test.clerk.accounts.dev", **extra) -> str:
    now = int(time.time())
    claims = {"sub": user_id, "iss": issuer, "iat": now, "exp": now + 300, "azp": "http://localhost:3000", **extra}
    return jwt.encode(claims, _key, algorithm="RS256")


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(user_id)}"}
