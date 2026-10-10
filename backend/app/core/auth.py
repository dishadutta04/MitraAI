from __future__ import annotations

import base64
from functools import lru_cache

import jwt
from fastapi import Header, HTTPException, WebSocket

from app.core.config import settings


class AuthError(Exception):
    pass


def clerk_issuer() -> str | None:
    if settings.clerk_issuer:
        return settings.clerk_issuer.rstrip("/")
    key = settings.clerk_publishable_key
    if not key or not key.startswith(("pk_test_", "pk_live_")):
        return None
    encoded = key.split("_", 2)[2]
    domain = base64.b64decode(encoded + "=" * (-len(encoded) % 4)).decode().rstrip("$")
    return f"https://{domain}"


@lru_cache(maxsize=1)
def _jwks_client(issuer: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{issuer}/.well-known/jwks.json", cache_keys=True, lifespan=3600)


def verify_token(token: str) -> str:
    """Checks a Clerk session token and returns the Clerk user id (the `sub` claim)."""
    issuer = clerk_issuer()
    if not issuer:
        raise AuthError("Clerk is not configured on the server (set CLERK_PUBLISHABLE_KEY or CLERK_ISSUER)")
    try:
        signing_key = _jwks_client(issuer).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer,
            options={"require": ["exp", "sub", "iss"]},
            leeway=10,
        )
    except jwt.PyJWTError as exc:
        raise AuthError(f"Invalid session: {exc}") from exc

    allowed = [p.strip() for p in settings.clerk_authorized_parties.split(",") if p.strip()]
    azp = claims.get("azp")
    if azp and allowed and azp not in allowed:
        raise AuthError("Session was issued for another site")
    return str(claims["sub"])


def current_user_id(authorization: str | None = Header(default=None)) -> str:
    """FastAPI dependency: the signed-in Clerk user, from `Authorization: Bearer <token>`."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in required")
    try:
        return verify_token(authorization.split(" ", 1)[1].strip())
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def websocket_user_id(websocket: WebSocket) -> str | None:
    """Browsers can't set headers on a WebSocket, so the session token comes as ?token=."""
    token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        return verify_token(token)
    except AuthError:
        return None
