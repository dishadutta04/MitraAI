from __future__ import annotations

from typing import Any, TypedDict


class MitraGraphState(TypedDict, total=False):
    thread_id: str
    user_id: str
    user_text: str
    user_profile: dict[str, Any]
    reviewed_items: list[dict[str, Any]]
    payment_method: str
    payment_id: str | None

    intent: dict[str, Any]
    guardrail: dict[str, Any]
    plan: dict[str, Any]
    offers: list[dict[str, Any]]
    offers_by_item: list[dict[str, Any]]
    comparison: dict[str, Any]
    decision: dict[str, Any]
    purchase: dict[str, Any]
    notification: dict[str, Any]

    clarification_needed: bool
    awaiting_confirmation: bool
    approved: bool | None
    error: str | None
