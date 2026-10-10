from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


PaymentMethod = Literal["cod", "upi_on_delivery", "online"]


class FamilyContact(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    relation: str = Field(default="", max_length=40)
    phone: str = Field(default="", max_length=20)
    email: str = Field(default="", max_length=200)


class AlertSettings(BaseModel):
    """Who gets told when an order is placed, and how."""

    sms: bool = True
    email: bool = True
    notify_family: bool = True


class VoiceSettings(BaseModel):
    voice_language: Literal["en-IN", "hi-IN"] = "en-IN"
    script: Literal["roman", "devanagari"] = "roman"
    read_aloud: bool = True


class ProfileFields(BaseModel):
    """Everything the onboarding steps (and the Profile page) can set."""

    name: str = Field(min_length=1, max_length=120)
    age: int = Field(ge=1, le=120)
    phone: str = Field(default="", max_length=32)
    email: str = Field(default="", max_length=200)
    address: str = Field(default="", max_length=500)
    language: Literal["hinglish", "hindi", "english"] = "hinglish"
    preferred_stores: list[Literal["zepto", "amazon"]] = Field(default_factory=lambda: ["zepto", "amazon"])
    payment_method: PaymentMethod = "cod"
    conditions: list[str] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)
    medications: list[str] = Field(default_factory=list)
    diet_notes: str = Field(default="", max_length=1000)
    family_contacts: list[FamilyContact] = Field(default_factory=list, max_length=5)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    alerts: AlertSettings = Field(default_factory=AlertSettings)
    onboarding_completed: bool = False


class UserProfile(ProfileFields):
    id: str
    preferences: dict[str, Any] = Field(default_factory=dict)


class IntentInput(BaseModel):
    user_text: str


class ParseRequest(BaseModel):
    message: str


class IntentItem(BaseModel):
    item: str
    quantity: int = Field(default=1, ge=1, le=99)
    preferences: list[str] = Field(default_factory=list)
    # "said" (user gave a number) / "base" (no number: 1 base pack) / "people" ("for 4 people")
    basis: Literal["said", "base", "people"] = "said"
    note: str | None = None


class WordInfo(BaseModel):
    """One spoken word in both scripts, and what Mitra understood it as."""

    hindi: str
    roman: str
    kind: Literal["number", "unit", "item", "separator", "urgency", "filler", "unknown"]
    meaning: str | None = None
    index: int = 0  # position of the spoken word in the request text


class ParsePreview(BaseModel):
    """What Mitra understood from the text, shown before any agent runs."""

    items: list[IntentItem]
    urgency: Literal["low", "medium", "high"]
    roman_text: str
    words: list[WordInfo] = Field(default_factory=list)


class StructuredIntent(BaseModel):
    # item / quantity / preferences mirror items[0], for single-item readers.
    item: str | None = None
    quantity: int | None = None
    urgency: Literal["low", "medium", "high"] = "medium"
    preferences: list[str] = Field(default_factory=list)
    items: list[IntentItem] = Field(default_factory=list)
    raw_text: str

    def item_list(self) -> list[IntentItem]:
        if self.items:
            return self.items
        if self.item:
            return [IntentItem(item=self.item, quantity=self.quantity or 1, preferences=self.preferences)]
        return []


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
    pack: str | None = None
    unit_price: int
    eta_minutes: int
    in_stock: bool
    quantity_supported: int


class ComparisonLine(BaseModel):
    item: str
    quantity: int
    ranked: list[ProductOption]


class ComparisonResult(BaseModel):
    ranked: list[ProductOption]  # first item's options
    rationale: str
    lines: list[ComparisonLine] = Field(default_factory=list)


class OrderLine(BaseModel):
    item: str
    quantity: int
    option: ProductOption | None = None  # the pick: best-ranked, or the buyer's choice
    options: list[ProductOption] = Field(default_factory=list)  # what the buyer can choose from


class DecisionResult(BaseModel):
    confirmation_required: bool = True
    recommendation: ProductOption | None = None  # first line's pick
    lines: list[OrderLine] = Field(default_factory=list)
    reasoning: str


class PurchaseResult(BaseModel):
    status: Literal["pending", "confirmed", "failed", "skipped"]
    idempotency_key: str | None = None
    order_id: str | None = None
    order_ids: list[str] = Field(default_factory=list)
    message: str


class AlertResult(BaseModel):
    channel: Literal["sms", "email"]
    to: str
    who: str  # "you" or the family member's name
    status: Literal["sent", "failed", "not_configured"]
    error: str | None = None


class NotificationResult(BaseModel):
    user_message: str
    family_webhook_status: Literal["sent", "skipped"]
    alerts: list[AlertResult] = Field(default_factory=list)


class TimelineEvent(BaseModel):
    event: str
    agent_name: str
    data: dict[str, Any]
    thread_id: str


class OrderStartRequest(BaseModel):
    message: str
    # Items as the buyer checked them in the review card (quantities changed with + / -).
    # When given, they are used instead of reading the message again.
    items: list[IntentItem] | None = None


class OrderResumeRequest(BaseModel):
    approved: bool
    payment_method: PaymentMethod | None = None
    # Razorpay checkout's success response, when payment_method is "online".
    razorpay_order_id: str | None = None
    razorpay_payment_id: str | None = None
    razorpay_signature: str | None = None
    # Which option the buyer picked for each order line: {line index: option index}.
    selections: dict[int, int] = Field(default_factory=dict)


class OrderResponse(BaseModel):
    thread_id: str
    status: str
    confirmation_required: bool = False
    confirmation_payload: dict[str, Any] | None = None
    message: str
    state: dict[str, Any]


class OrderHistoryLine(BaseModel):
    item: str
    vendor: str
    quantity: int
    price_total: int


class OrderHistoryEntry(BaseModel):
    """One placed order (all lines bought in one approval), newest first."""

    thread_id: str
    request_text: str | None
    created_at: str
    status: str
    payment_method: str | None
    total: int
    lines: list[OrderHistoryLine]


class PaymentConfig(BaseModel):
    online_enabled: bool
    key_id: str | None = None


class PaymentStartRequest(BaseModel):
    selections: dict[int, int] = Field(default_factory=dict)


class PaymentStart(BaseModel):
    """What the browser needs to open Razorpay Checkout for this order."""

    key_id: str
    razorpay_order_id: str
    amount_paise: int
    currency: str
    name: str
    description: str
    prefill: dict[str, str]
