from __future__ import annotations

import hashlib
import random
import re
import time
from typing import Any

from langgraph.types import interrupt

from app.graph.state import MitraGraphState
from app.schemas import (
    ComparisonResult,
    DecisionResult,
    GuardrailResult,
    NotificationResult,
    PlanResult,
    ProductOption,
    PurchaseResult,
    StructuredIntent,
)
from app.services.llm_client import choose_model_name, generate_notification_with_llm, parse_intent_with_llm
from app.services.health_rules import evaluate_health_risks
from app.services.mcp_clients import search_products
from app.services.redis_bus import redis_bus
from app.services.repositories import create_order, get_order_by_idempotency, write_audit_log

SUGAR_ITEMS = {"sugar", "gulab jamun", "rasgulla", "cola", "cake", "jalebi"}
HIGH_SODIUM_ITEMS = {"salt", "chips", "pickle", "namkeen"}


def _emit(state: MitraGraphState, agent: str, event: str, data: dict[str, Any]) -> None:
    thread_id = state.get("thread_id", "unknown-thread")
    payload = {"event": event, "agent_name": agent, "data": data, "thread_id": thread_id}
    redis_bus.publish_event(thread_id, payload)
    write_audit_log(thread_id=thread_id, event_type=event, agent_name=agent, payload=data)


def intent_agent(state: MitraGraphState) -> MitraGraphState:
    text = state.get("user_text", "").lower().strip()
    _emit(state, "Intent Agent", "agent_started", {"text": text, "model": choose_model_name()})

    llm_intent = parse_intent_with_llm(state.get("user_text", ""))
    if llm_intent:
        intent = StructuredIntent(
            item=llm_intent.get("item"),
            quantity=llm_intent.get("quantity", 1),
            urgency=llm_intent.get("urgency", "medium"),
            preferences=llm_intent.get("preferences", []),
            raw_text=state.get("user_text", ""),
        )
    else:
        qty_match = re.search(r"(\d+)", text)
        quantity = int(qty_match.group(1)) if qty_match else 1

        urgency = "medium"
        if any(token in text for token in ["jaldi", "urgent", "abhi", "asap"]):
            urgency = "high"
        elif any(token in text for token in ["koi jaldi nahi", "later", "normal"]):
            urgency = "low"

        cleaned = re.sub(r"\d+", "", text)
        for token in ["kg", "kilo", "packet", "pack", "please", "chahiye", "mangao", "order", "kar do"]:
            cleaned = cleaned.replace(token, "")
        item = " ".join(cleaned.split()).strip() or None
        intent = StructuredIntent(item=item, quantity=quantity, urgency=urgency, raw_text=state.get("user_text", ""))
    _emit(state, "Intent Agent", "agent_completed", {"intent": intent.model_dump()})
    return {"intent": intent.model_dump()}


def guardrail_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Health Guardrail Agent", "agent_started", {})
    intent = StructuredIntent(**state.get("intent", {}))
    profile = state.get("user_profile", {})
    conditions = [str(c).lower() for c in profile.get("conditions", [])]
    medications = [str(m).lower() for m in profile.get("preferences", {}).get("medications", [])]

    result = GuardrailResult()
    if intent.item:
        matches = evaluate_health_risks(intent.item, conditions, medications)
        if not matches:
            item_lower = intent.item.lower()
            if "diabetes" in conditions and any(word in item_lower for word in SUGAR_ITEMS):
                result.warnings.append("High sugar item flagged for diabetic profile")
                result.clinical_notes.append("Why flagged: rapid sugar spikes can destabilize glucose control.")
                result.healthier_alternatives.extend(["multigrain biscuits", "sugar-free snacks"])
            if "hypertension" in conditions and any(word in item_lower for word in HIGH_SODIUM_ITEMS):
                result.warnings.append("High sodium item flagged for hypertensive profile")
                result.clinical_notes.append("Why flagged: high sodium can push blood pressure upward.")
                result.healthier_alternatives.extend(["low sodium salt", "roasted makhana"])
        else:
            for match in matches:
                result.warnings.append(match.warning)
                result.clinical_notes.append(f"Why flagged: {match.why}")
                result.healthier_alternatives.extend(match.alternatives)
                if match.severity == "high":
                    result.risk_level = "high"
                elif result.risk_level != "high" and match.severity == "medium":
                    result.risk_level = "medium"

    quantity = intent.quantity or 1
    if quantity > 15:
        corrected = 2 if quantity > 50 else 5
        result.warnings.append(f"Bulk quantity {quantity} adjusted to safer value {corrected}")
        result.clinical_notes.append("Why flagged: accidental bulk orders can be unsafe and financially risky.")
        result.corrected_quantity = corrected
        if result.risk_level == "low":
            result.risk_level = "medium"

    if result.corrected_quantity:
        intent.quantity = result.corrected_quantity

    if result.risk_level == "high":
        result.blocked = False
    if not result.warnings:
        result.risk_level = "low"

    if result.healthier_alternatives:
        result.healthier_alternatives = list(dict.fromkeys(result.healthier_alternatives))

    _emit(
        state,
        "Health Guardrail Agent",
        "agent_completed",
        {"guardrail": result.model_dump(), "updated_intent": intent.model_dump()},
    )
    return {"guardrail": result.model_dump(), "intent": intent.model_dump()}


def planning_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Planning Agent", "agent_started", {})
    intent = StructuredIntent(**state.get("intent", {}))
    question = None
    ready = True

    if not intent.item:
        ready = False
        question = "Kaunsa item mangwana hai?"
    elif not intent.quantity:
        ready = False
        question = f"{intent.item} kitni quantity chahiye?"

    plan = PlanResult(ready_for_search=ready, clarification_question=question)
    _emit(state, "Planning Agent", "agent_completed", {"plan": plan.model_dump()})
    return {"plan": plan.model_dump(), "clarification_needed": not ready}


def search_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Search Agent", "agent_started", {"integration": "simulated-mcp"})
    intent = StructuredIntent(**state.get("intent", {}))
    item = intent.item or "grocery item"
    quantity = intent.quantity or 1

    options = search_products(item=item, quantity=quantity)
    _emit(state, "Search Agent", "agent_completed", {"offers_found": len(options)})
    return {"offers": [opt.model_dump() for opt in options]}


def comparison_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Comparison Agent", "agent_started", {})
    intent = StructuredIntent(**state.get("intent", {}))
    offers = [ProductOption(**o) for o in state.get("offers", [])]

    def score(opt: ProductOption) -> float:
        urgency_bonus = max(0, 120 - opt.eta_minutes) if intent.urgency == "high" else max(0, 60 - opt.eta_minutes)
        price_bonus = max(0, 120 - opt.unit_price)
        return urgency_bonus * 0.65 + price_bonus * 0.35

    ranked = sorted([o for o in offers if o.in_stock], key=score, reverse=True)
    rationale = "Urgency-weighted ranking applied (eta prioritized for urgent requests)."
    comparison = ComparisonResult(ranked=ranked, rationale=rationale)
    _emit(state, "Comparison Agent", "agent_completed", {"top_vendor": ranked[0].vendor if ranked else None})
    return {"comparison": comparison.model_dump()}


def decision_hitl_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Decision & HITL Agent", "agent_started", {})
    plan = PlanResult(**state.get("plan", {}))

    if not plan.ready_for_search:
        decision = DecisionResult(
            confirmation_required=False,
            recommendation=None,
            reasoning=plan.clarification_question or "Need clarification before searching",
        )
        _emit(state, "Decision & HITL Agent", "agent_completed", {"decision": decision.model_dump()})
        return {"decision": decision.model_dump(), "awaiting_confirmation": False}

    ranked = state.get("comparison", {}).get("ranked", [])
    recommendation = ProductOption(**ranked[0]) if ranked else None
    decision = DecisionResult(
        confirmation_required=True,
        recommendation=recommendation,
        reasoning="Best value selected based on urgency, ETA and price.",
    )
    _emit(state, "Decision & HITL Agent", "confirmation_requested", {"decision": decision.model_dump()})
    return {"decision": decision.model_dump(), "awaiting_confirmation": True}


def purchase_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Purchase Agent", "agent_started", {})
    decision = DecisionResult(**state.get("decision", {}))

    if not decision.confirmation_required:
        skipped = PurchaseResult(status="skipped", message="Purchase skipped until clarification")
        _emit(state, "Purchase Agent", "agent_completed", {"purchase": skipped.model_dump()})
        return {"purchase": skipped.model_dump()}

    approval = interrupt(
        {
            "type": "purchase_confirmation",
            "title": "Please confirm order",
            "recommendation": decision.recommendation.model_dump() if decision.recommendation else None,
        }
    )

    approved = bool(approval.get("approved", False)) if isinstance(approval, dict) else bool(approval)
    if not approved:
        declined = PurchaseResult(status="skipped", message="Order cancelled by user confirmation")
        _emit(state, "Purchase Agent", "agent_completed", {"purchase": declined.model_dump()})
        return {"purchase": declined.model_dump(), "approved": False}

    rec = decision.recommendation
    if rec is None:
        failed = PurchaseResult(status="failed", message="Missing recommendation details")
        _emit(state, "Purchase Agent", "agent_failed", {"purchase": failed.model_dump()})
        return {"purchase": failed.model_dump(), "approved": True}

    intent = StructuredIntent(**state.get("intent", {}))
    user_id = state.get("user_id", "unknown")
    raw_key = f"{state.get('thread_id')}|{user_id}|{rec.vendor}|{rec.item_name}|{intent.quantity}"
    idem_key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:32]

    existing = get_order_by_idempotency(idem_key)
    if existing:
        completed = PurchaseResult(
            status="confirmed",
            idempotency_key=idem_key,
            order_id=f"existing-{existing['id']}",
            message="Order already placed earlier. Returning idempotent result.",
        )
        _emit(state, "Purchase Agent", "idempotent_hit", {"idempotency_key": idem_key})
        return {"purchase": completed.model_dump(), "approved": True}

    retries = 3
    for attempt in range(1, retries + 1):
        try:
            # Simulate transient downstream issue.
            if random.random() < 0.2 and attempt < retries:
                raise RuntimeError("Transient vendor timeout")
            total = rec.unit_price * (intent.quantity or 1)
            order_id = create_order(
                thread_id=state.get("thread_id", ""),
                user_id=user_id,
                idempotency_key=idem_key,
                vendor=rec.vendor,
                item=rec.item_name,
                quantity=intent.quantity or 1,
                price_total=total,
                status="confirmed",
            )
            success = PurchaseResult(
                status="confirmed",
                idempotency_key=idem_key,
                order_id=f"ORD-{order_id}",
                message="Order placed successfully.",
            )
            _emit(state, "Purchase Agent", "agent_completed", {"purchase": success.model_dump(), "attempt": attempt})
            return {"purchase": success.model_dump(), "approved": True}
        except Exception as exc:
            _emit(
                state,
                "Purchase Agent",
                "retrying",
                {"attempt": attempt, "error": str(exc)},
            )
            time.sleep(0.3)

    failed = PurchaseResult(status="failed", idempotency_key=idem_key, message="Purchase failed after retries")
    _emit(state, "Purchase Agent", "agent_failed", {"purchase": failed.model_dump()})
    return {"purchase": failed.model_dump(), "approved": True}


def notification_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Notification Agent", "agent_started", {})
    plan = PlanResult(**state.get("plan", {"ready_for_search": True}))
    decision = state.get("decision", {})
    purchase = PurchaseResult(**state.get("purchase", {"status": "skipped", "message": "No purchase"}))

    if not plan.ready_for_search:
        result = NotificationResult(
            user_message=plan.clarification_question or "Please share item details.",
            family_webhook_status="skipped",
        )
        _emit(state, "Notification Agent", "agent_completed", {"notification": result.model_dump()})
        return {"notification": result.model_dump()}

    rec = decision.get("recommendation") or {}
    if purchase.status == "confirmed":
        msg_seed = (
            f"Order confirmed: {rec.get('item_name', 'item')} from {rec.get('vendor', 'vendor')} "
            f"with ETA {rec.get('eta_minutes', '?')} min. Family ko bhi update bhej diya."
        )
        msg = generate_notification_with_llm(msg_seed) or msg_seed
        webhook = "sent"
    elif purchase.status == "skipped":
        msg_seed = "Theek hai, order cancel kar diya. Jab bolenge tab phir se kar denge."
        msg = generate_notification_with_llm(msg_seed) or msg_seed
        webhook = "skipped"
    else:
        msg_seed = "Order place nahi ho paya. Main turant dubara try kar sakta hoon."
        msg = generate_notification_with_llm(msg_seed) or msg_seed
        webhook = "sent"

    result = NotificationResult(user_message=msg, family_webhook_status=webhook)
    _emit(state, "Notification Agent", "agent_completed", {"notification": result.model_dump()})
    return {"notification": result.model_dump()}
