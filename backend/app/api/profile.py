from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import current_user_id
from app.schemas import ProfileFields, UserProfile
from app.services.alerts import normalize_phone
from app.services.repositories import get_user_profile, save_user_profile

router = APIRouter(prefix="/api/v1/profile", tags=["profile"])


@router.get("/me", response_model=UserProfile)
def read_profile(user_id: str = Depends(current_user_id)) -> UserProfile:
    """404 means the user hasn't finished onboarding yet."""
    try:
        return get_user_profile(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Profile not set up yet") from exc


@router.put("/me", response_model=UserProfile)
def update_profile(fields: ProfileFields, user_id: str = Depends(current_user_id)) -> UserProfile:
    # The mobile number is collected here, not at sign-in; delivery and SMS alerts depend on it.
    phone = normalize_phone(fields.phone)
    if phone is None:
        raise HTTPException(status_code=422, detail="Please enter a valid mobile number")
    return save_user_profile(user_id, fields.model_copy(update={"phone": phone}))
