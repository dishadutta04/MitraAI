from __future__ import annotations

from typing import Literal
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.agents.nodes import (
    comparison_agent,
    decision_hitl_agent,
    guardrail_agent,
    intent_agent,
    notification_agent,
    planning_agent,
    purchase_agent,
    search_agent,
)
from app.graph.state import MitraGraphState

memory = MemorySaver()


def _route_after_planning(state: MitraGraphState) -> Literal["search", "notification"]:
    plan = state.get("plan", {})
    if plan.get("ready_for_search"):
        return "search"
    return "notification"


def build_graph():
    workflow = StateGraph(MitraGraphState)

    workflow.add_node("intent_node", intent_agent)
    workflow.add_node("guardrail_node", guardrail_agent)
    workflow.add_node("planning_node", planning_agent)
    workflow.add_node("search_node", search_agent)
    workflow.add_node("comparison_node", comparison_agent)
    workflow.add_node("decision_node", decision_hitl_agent)
    workflow.add_node("purchase_node", purchase_agent)
    workflow.add_node("notification_node", notification_agent)

    workflow.add_edge(START, "intent_node")
    workflow.add_edge("intent_node", "guardrail_node")
    workflow.add_edge("guardrail_node", "planning_node")
    workflow.add_conditional_edges(
        "planning_node",
        _route_after_planning,
        {"search": "search_node", "notification": "notification_node"},
    )
    workflow.add_edge("search_node", "comparison_node")
    workflow.add_edge("comparison_node", "decision_node")
    workflow.add_edge("decision_node", "purchase_node")
    workflow.add_edge("purchase_node", "notification_node")
    workflow.add_edge("notification_node", END)

    return workflow.compile(checkpointer=memory)


graph = build_graph()


def start_graph(initial_state: MitraGraphState) -> dict:
    config = {"configurable": {"thread_id": initial_state["thread_id"]}}
    output = graph.invoke(initial_state, config=config)
    snapshot = graph.get_state(config)
    interrupted = bool(getattr(snapshot, "interrupts", None))

    interrupt_payload = None
    if interrupted:
        first_interrupt = snapshot.interrupts[0]
        interrupt_payload = first_interrupt.value

    return {
        "state": output,
        "interrupted": interrupted,
        "interrupt_payload": interrupt_payload,
    }


def thread_owner(thread_id: str) -> str | None:
    """The user who started this order thread, or None if the thread isn't known."""
    snapshot = graph.get_state({"configurable": {"thread_id": thread_id}})
    return (snapshot.values or {}).get("user_id")


def pending_order_lines(thread_id: str) -> list[dict] | None:
    """The order lines waiting for approval on this thread (None if it isn't waiting)."""
    snapshot = graph.get_state({"configurable": {"thread_id": thread_id}})
    if not getattr(snapshot, "interrupts", None):
        return None
    return list((snapshot.values or {}).get("decision", {}).get("lines", []))


def resume_graph(
    thread_id: str,
    approved: bool,
    selections: dict[int, int] | None = None,
    payment_method: str | None = None,
    payment_id: str | None = None,
) -> dict:
    config = {"configurable": {"thread_id": thread_id}}
    resume = {
        "approved": approved,
        "selections": selections or {},
        "payment_method": payment_method,
        "payment_id": payment_id,
    }
    output = graph.invoke(Command(resume=resume), config=config)
    snapshot = graph.get_state(config)
    interrupted = bool(getattr(snapshot, "interrupts", None))

    return {
        "state": output,
        "interrupted": interrupted,
        "interrupt_payload": snapshot.interrupts[0].value if interrupted else None,
    }
