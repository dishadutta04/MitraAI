from __future__ import annotations

import uuid
from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import current_user_id
from app.core.config import settings
from app.graph.workflow import pending_order_lines, resume_graph, start_graph, thread_owner
from app.graph.state import MitraGraphState
from app.schemas import (
    IntentItem,
    OrderHistoryEntry,
    OrderResponse,
    OrderResumeRequest,
    OrderStartRequest,
    ParsePreview,
    PaymentConfig,
    PaymentStart,
    PaymentStartRequest,
    ParseRequest,
    WordInfo,
)
from app.services import payments
from app.services.repositories import get_payment, get_user_profile, list_orders, save_payment, update_payment
from app.services.voice_text import explain_words, parse_request

router = APIRouter(prefix="/api/v1/orders", tags=["orders"])


@router.post("/parse", response_model=ParsePreview)
def parse_order(request: ParseRequest, _user_id: str = Depends(current_user_id)) -> ParsePreview:
    """Preview of item/quantity/urgency for the review card; runs no agents."""
    parsed = parse_request(request.message)
    return ParsePreview(
        items=[
            IntentItem(item=i.item, quantity=i.quantity, preferences=i.preferences, basis=i.basis, note=i.note)
            for i in parsed.items
        ],
        urgency=parsed.urgency,
        roman_text=parsed.normalized_text,
        words=[WordInfo(**w) for w in explain_words(request.message)],
    )


@router.get("/history", response_model=list[OrderHistoryEntry])
def order_history(user_id: str = Depends(current_user_id)) -> list[OrderHistoryEntry]:
    return list_orders(user_id)


@router.post("/start", response_model=OrderResponse)
def start_order(request: OrderStartRequest, user_id: str = Depends(current_user_id)) -> OrderResponse:
    try:
        profile = get_user_profile(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail="Finish setting up your profile first") from exc

    thread_id = str(uuid.uuid4())
    initial_state: MitraGraphState = {
        "thread_id": thread_id,
        "user_id": user_id,
        "user_text": request.message,
        "user_profile": profile.model_dump(),
        "payment_method": profile.payment_method,
    }
    if request.items:
        initial_state["reviewed_items"] = [item.model_dump() for item in request.items]

    result = start_graph(initial_state)
    state = result["state"]

    if result["interrupted"]:
        return OrderResponse(
            thread_id=thread_id,
            status="awaiting_confirmation",
            confirmation_required=True,
            confirmation_payload=result["interrupt_payload"],
            message="Confirmation required before purchase.",
            state=state,
        )

    notification = state.get("notification", {})
    return OrderResponse(
        thread_id=thread_id,
        status="completed",
        confirmation_required=False,
        message=notification.get("user_message", "Request processed."),
        state=state,
    )


def _order_total(lines: list[dict], selections: dict[int, int]) -> int:
    """Rupees for the picks on the approval card, from the server's own copy of the options."""
    total = 0
    for index, line in enumerate(lines):
        options = line.get("options") or ([line["option"]] if line.get("option") else [])
        choice = selections.get(index, 0)
        pick = options[choice] if 0 <= choice < len(options) else line.get("option")
        if pick:
            total += int(pick["unit_price"]) * int(line["quantity"])
    return total


@router.get("/payment-config", response_model=PaymentConfig)
def payment_config(_user_id: str = Depends(current_user_id)) -> PaymentConfig:
    enabled = payments.online_enabled()
    return PaymentConfig(online_enabled=enabled, key_id=settings.razorpay_key_id if enabled else None)


@router.post("/{thread_id}/payment", response_model=PaymentStart)
def start_payment(thread_id: str, request: PaymentStartRequest, user_id: str = Depends(current_user_id)) -> PaymentStart:
    """Creates the Razorpay order for what's on the approval card; the browser then opens Checkout."""
    if thread_owner(thread_id) != user_id:
        raise HTTPException(status_code=404, detail="Order not found")
    lines = pending_order_lines(thread_id)
    if lines is None:
        raise HTTPException(status_code=409, detail="This order isn't waiting for payment")
    if not payments.online_enabled():
        raise HTTPException(status_code=503, detail="Online payment isn't set up on the server")
    existing = get_payment(thread_id)
    if existing and existing["status"] != "created":
        raise HTTPException(status_code=409, detail="This order has already been paid")

    amount_paise = _order_total(lines, request.selections) * 100
    if amount_paise <= 0:
        raise HTTPException(status_code=400, detail="Nothing to pay for")
    profile = get_user_profile(user_id)
    try:
        order = payments.create_order(amount_paise, receipt=thread_id, notes={"thread_id": thread_id, "user_id": user_id})
    except payments.PaymentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    save_payment(thread_id, user_id, order["id"], amount_paise, request.selections)
    items = ", ".join(f"{l['quantity']} × {l['item']}" for l in lines)
    return PaymentStart(
        key_id=settings.razorpay_key_id or "",
        razorpay_order_id=order["id"],
        amount_paise=amount_paise,
        currency="INR",
        name="Mitra AI",
        description=items[:250],
        prefill={k: v for k, v in {"name": profile.name, "email": profile.email, "contact": profile.phone}.items() if v},
    )


@router.post("/{thread_id}/resume", response_model=OrderResponse)
def resume_order(thread_id: str, request: OrderResumeRequest, user_id: str = Depends(current_user_id)) -> OrderResponse:
    if thread_owner(thread_id) != user_id:
        raise HTTPException(status_code=404, detail="Order not found")

    selections, payment_id, paid = request.selections, None, None
    if request.approved and request.payment_method == "online":
        paid = get_payment(thread_id)
        if not paid or paid["razorpay_order_id"] != request.razorpay_order_id:
            raise HTTPException(status_code=400, detail="Payment doesn't match this order")
        if not request.razorpay_payment_id or not payments.signature_valid(
            paid["razorpay_order_id"], request.razorpay_payment_id, request.razorpay_signature or ""
        ):
            raise HTTPException(status_code=400, detail="Payment could not be verified")
        update_payment(thread_id, status="paid", razorpay_payment_id=request.razorpay_payment_id)
        # Buy exactly what was paid for, whatever the request says now.
        selections = {int(k): v for k, v in (paid["selections"] or {}).items()}
        payment_id = request.razorpay_payment_id

    result = resume_graph(
        thread_id=thread_id,
        approved=request.approved,
        selections=selections,
        payment_method=request.payment_method,
        payment_id=payment_id,
    )
    state = result["state"]

    # Paid but the purchase didn't go through: give the money back straight away.
    if paid and payment_id and (state.get("purchase") or {}).get("status") != "confirmed":
        refunded = payments.refund(payment_id, paid["amount_paise"])
        update_payment(thread_id, status="refunded" if refunded else "refund_failed")
        note = " Your payment has been refunded." if refunded else " Your refund is being processed."
        state.setdefault("notification", {})["user_message"] = (state.get("notification") or {}).get("user_message", "") + note

    if result["interrupted"]:
        return OrderResponse(
            thread_id=thread_id,
            status="awaiting_confirmation",
            confirmation_required=True,
            confirmation_payload=result["interrupt_payload"],
            message="Still awaiting confirmation.",
            state=state,
        )

    notification = state.get("notification", {})
    return OrderResponse(
        thread_id=thread_id,
        status="completed",
        confirmation_required=False,
        message=notification.get("user_message", "Request processed."),
        state=state,
    )
