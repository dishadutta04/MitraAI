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


def resume_graph(thread_id: str, approved: bool) -> dict:
    config = {"configurable": {"thread_id": thread_id}}
    output = graph.invoke(Command(resume={"approved": approved}), config=config)
    snapshot = graph.get_state(config)
    interrupted = bool(getattr(snapshot, "interrupts", None))

    return {
        "state": output,
        "interrupted": interrupted,
        "interrupt_payload": snapshot.interrupts[0].value if interrupted else None,
    }
