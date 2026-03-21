from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


class UserProfile(BaseModel):
    id: str
    name: str
    age: int
    conditions: list[str]
    preferences: dict[str, Any] = Field(default_factory=dict)


class IntentInput(BaseModel):
    user_text: str


class StructuredIntent(BaseModel):
    item: str | None = None
    quantity: int | None = None
    urgency: Literal["low", "medium", "high"] = "medium"
    preferences: list[str] = Field(default_factory=list)
    raw_text: str


class GuardrailResult(BaseModel):
    blocked: bool = False
    risk_level: Literal["low", "medium", "high"] = "low"
    warnings: list[str] = Field(default_factory=list)
    clinical_notes: list[str] = Field(default_factory=list)
    healthier_alternatives: list[str] = Field(default_factory=list)
    corrected_quantity: int | None = None


class PlanResult(BaseModel):
    ready_for_search: bool
    clarification_question: str | None = None


class ProductOption(BaseModel):
    vendor: Literal["zepto", "amazon"]
    item_name: str
    unit_price: int
    eta_minutes: int
    in_stock: bool
    quantity_supported: int


class ComparisonResult(BaseModel):
    ranked: list[ProductOption]
    rationale: str


class DecisionResult(BaseModel):
    confirmation_required: bool = True
    recommendation: ProductOption | None = None
    reasoning: str


class PurchaseResult(BaseModel):
    status: Literal["pending", "confirmed", "failed", "skipped"]
    idempotency_key: str | None = None
    order_id: str | None = None
    message: str


class NotificationResult(BaseModel):
    user_message: str
    family_webhook_status: Literal["sent", "skipped"]


class TimelineEvent(BaseModel):
    event: str
    agent_name: str
    data: dict[str, Any]
    thread_id: str


class OrderStartRequest(BaseModel):
    user_id: str = "dadaji-001"
    message: str


class OrderResumeRequest(BaseModel):
    user_id: str = "dadaji-001"
    approved: bool


class OrderResponse(BaseModel):
    thread_id: str
    status: str
    confirmation_required: bool = False
    confirmation_payload: dict[str, Any] | None = None
    message: str
    state: dict[str, Any]
