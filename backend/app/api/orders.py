from __future__ import annotations

import uuid
from fastapi import APIRouter, HTTPException

from app.graph.workflow import resume_graph, start_graph
from app.graph.state import MitraGraphState
from app.schemas import OrderResponse, OrderResumeRequest, OrderStartRequest
from app.services.repositories import get_user_profile

router = APIRouter(prefix="/api/v1/orders", tags=["orders"])


@router.post("/start", response_model=OrderResponse)
def start_order(request: OrderStartRequest) -> OrderResponse:
    try:
        profile = get_user_profile(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    thread_id = str(uuid.uuid4())
    initial_state: MitraGraphState = {
        "thread_id": thread_id,
        "user_id": request.user_id,
        "user_text": request.message,
        "user_profile": profile.model_dump(),
    }

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


@router.post("/{thread_id}/resume", response_model=OrderResponse)
def resume_order(thread_id: str, request: OrderResumeRequest) -> OrderResponse:
    result = resume_graph(thread_id=thread_id, approved=request.approved)
    state = result["state"]

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
