from __future__ import annotations

import hashlib
import random
import time
from typing import Any

from langgraph.types import interrupt

from app.graph.state import MitraGraphState
from app.schemas import (
    AlertResult,
    ComparisonResult,
    DecisionResult,
    ComparisonLine,
    GuardrailResult,
    IntentItem,
    NotificationResult,
    OrderLine,
    PlanResult,
    ProductOption,
    PurchaseResult,
    StructuredIntent,
    UserProfile,
)
from app.services.alerts import send_order_alerts
from app.services.llm_client import choose_model_name, generate_notification_with_llm, parse_intent_with_llm
from app.services.health_rules import evaluate_health_risks
from app.services.mcp_clients import search_products
from app.services.redis_bus import redis_bus
from app.services.repositories import create_order, get_order_by_idempotency, write_audit_log
from app.services.voice_text import parse_request

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

    reviewed = state.get("reviewed_items")
    llm_intent = None if reviewed else parse_intent_with_llm(state.get("user_text", ""))
    if reviewed:
        # The buyer already checked (and maybe changed) the items in the review card.
        parsed = parse_request(state.get("user_text", ""))
        items = [IntentItem(**i) for i in reviewed]
        intent = StructuredIntent(
            item=items[0].item if items else None,
            quantity=items[0].quantity if items else 1,
            urgency=parsed.urgency,
            preferences=items[0].preferences if items else [],
            items=items,
            raw_text=state.get("user_text", ""),
        )
    elif llm_intent:
        intent = StructuredIntent(
            item=llm_intent.get("item"),
            quantity=llm_intent.get("quantity", 1),
            urgency=llm_intent.get("urgency", "medium"),
            preferences=llm_intent.get("preferences", []),
            raw_text=state.get("user_text", ""),
        )
    else:
        parsed = parse_request(state.get("user_text", ""))
        intent = StructuredIntent(
            item=parsed.item,
            quantity=parsed.quantity,
            urgency=parsed.urgency,
            preferences=parsed.preferences,
            items=[
                IntentItem(item=i.item, quantity=i.quantity, preferences=i.preferences, basis=i.basis, note=i.note)
                for i in parsed.items
            ],
            raw_text=state.get("user_text", ""),
        )
    _emit(state, "Intent Agent", "agent_completed", {"intent": intent.model_dump()})
    return {"intent": intent.model_dump()}


def _sync_first_item(intent: StructuredIntent) -> StructuredIntent:
    """Keep the single-item fields equal to items[0] after items change."""
    first = intent.items[0] if intent.items else None
    intent.item = first.item if first else None
    intent.quantity = first.quantity if first else intent.quantity
    intent.preferences = list(first.preferences) if first else intent.preferences
    return intent


def guardrail_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Health Guardrail Agent", "agent_started", {})
    intent = StructuredIntent(**state.get("intent", {}))
    items = intent.item_list()
    profile = state.get("user_profile", {})
    conditions = [str(c).lower() for c in profile.get("conditions", [])]
    medications = [str(m).lower() for m in profile.get("medications") or profile.get("preferences", {}).get("medications", [])]
    allergies = [str(a).lower().strip() for a in profile.get("allergies") or [] if str(a).strip()]
    many = len(items) > 1

    result = GuardrailResult()

    def warn(line: IntentItem, warning: str) -> None:
        result.warnings.append(f"{line.item}: {warning}" if many else warning)

    for line in items:
        for allergy in allergies:
            if allergy in line.item.lower() or line.item.lower() in allergy:
                warn(line, f"Listed allergy: {allergy}")
                result.clinical_notes.append(f"Why flagged: {allergy} is in the allergy list on the health profile.")
                result.risk_level = "high"
        matches = evaluate_health_risks(line.item, conditions, medications)
        if not matches:
            item_lower = line.item.lower()
            if "diabetes" in conditions and any(word in item_lower for word in SUGAR_ITEMS):
                warn(line, "High sugar item flagged for diabetic profile")
                result.clinical_notes.append("Why flagged: rapid sugar spikes can destabilize glucose control.")
                result.healthier_alternatives.extend(["multigrain biscuits", "sugar-free snacks"])
            if "hypertension" in conditions and any(word in item_lower for word in HIGH_SODIUM_ITEMS):
                warn(line, "High sodium item flagged for hypertensive profile")
                result.clinical_notes.append("Why flagged: high sodium can push blood pressure upward.")
                result.healthier_alternatives.extend(["low sodium salt", "roasted makhana"])
        else:
            for match in matches:
                warn(line, match.warning)
                result.clinical_notes.append(f"Why flagged: {match.why}")
                result.healthier_alternatives.extend(match.alternatives)
                if match.severity == "high":
                    result.risk_level = "high"
                elif result.risk_level != "high" and match.severity == "medium":
                    result.risk_level = "medium"

        if line.quantity > 15:
            corrected = 2 if line.quantity > 50 else 5
            warn(line, f"Bulk quantity {line.quantity} adjusted to safer value {corrected}")
            result.clinical_notes.append("Why flagged: accidental bulk orders can be unsafe and financially risky.")
            result.corrected_quantity = result.corrected_quantity or corrected
            line.quantity = corrected
            if result.risk_level == "low":
                result.risk_level = "medium"

    intent.items = items
    _sync_first_item(intent)

    if result.risk_level == "high":
        result.blocked = False
    if not result.warnings:
        result.risk_level = "low"

    if result.healthier_alternatives:
        result.healthier_alternatives = list(dict.fromkeys(result.healthier_alternatives))
    result.clinical_notes = list(dict.fromkeys(result.clinical_notes))

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

    if not intent.item_list():
        ready = False
        question = "Which item would you like to order?"

    plan = PlanResult(ready_for_search=ready, clarification_question=question)
    _emit(state, "Planning Agent", "agent_completed", {"plan": plan.model_dump()})
    return {"plan": plan.model_dump(), "clarification_needed": not ready}


def search_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Search Agent", "agent_started", {"integration": "simulated-mcp"})
    intent = StructuredIntent(**state.get("intent", {}))

    offers_by_item = []
    for line in intent.item_list():
        options = search_products(item=line.item, quantity=line.quantity)
        offers_by_item.append(
            {"item": line.item, "quantity": line.quantity, "offers": [opt.model_dump() for opt in options]}
        )
    total = sum(len(group["offers"]) for group in offers_by_item)
    _emit(state, "Search Agent", "agent_completed", {"offers_found": total, "items": len(offers_by_item)})
    return {
        "offers_by_item": offers_by_item,
        "offers": offers_by_item[0]["offers"] if offers_by_item else [],
    }


def comparison_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Comparison Agent", "agent_started", {})
    intent = StructuredIntent(**state.get("intent", {}))

    def score(opt: ProductOption, cheapest: int) -> float:
        urgency_bonus = max(0, 120 - opt.eta_minutes) if intent.urgency == "high" else max(0, 60 - opt.eta_minutes)
        # Price relative to the cheapest option for the same item, so ₹28 milk and ₹360 rice compare fairly.
        price_bonus = 100 * cheapest / max(1, opt.unit_price)
        return urgency_bonus * 0.65 + price_bonus * 0.35

    lines = []
    for group in state.get("offers_by_item", []):
        offers = [ProductOption(**o) for o in group["offers"] if o.get("in_stock", True)]
        cheapest = min((o.unit_price for o in offers), default=1)
        ranked = sorted(offers, key=lambda o: score(o, cheapest), reverse=True)
        lines.append(ComparisonLine(item=group["item"], quantity=group["quantity"], ranked=ranked))

    rationale = "Urgency-weighted ranking applied (eta prioritized for urgent requests)."
    comparison = ComparisonResult(ranked=lines[0].ranked if lines else [], rationale=rationale, lines=lines)
    _emit(
        state,
        "Comparison Agent",
        "agent_completed",
        {"top_vendors": {line.item: (line.ranked[0].vendor if line.ranked else None) for line in lines}},
    )
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

    comparison = ComparisonResult(**state.get("comparison", {"ranked": [], "rationale": ""}))
    lines = [
        OrderLine(
            item=line.item,
            quantity=line.quantity,
            option=line.ranked[0] if line.ranked else None,
            options=line.ranked,
        )
        for line in comparison.lines
    ]
    decision = DecisionResult(
        confirmation_required=True,
        recommendation=lines[0].option if lines else None,
        lines=lines,
        reasoning="Options ranked for each item by urgency, ETA and price; the buyer picks one (best is preselected).",
    )
    _emit(state, "Decision & HITL Agent", "confirmation_requested", {"decision": decision.model_dump()})
    return {"decision": decision.model_dump(), "awaiting_confirmation": True}


def _place_line(state: MitraGraphState, index: int, line: OrderLine) -> PurchaseResult:
    """Places one order line with retries; idempotent per thread + line."""
    rec = line.option
    if rec is None:
        return PurchaseResult(status="failed", message=f"No offer found for {line.item}")

    user_id = state.get("user_id", "unknown")
    raw_key = f"{state.get('thread_id')}|{user_id}|{index}|{rec.vendor}|{rec.item_name}|{line.quantity}"
    idem_key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:32]

    existing = get_order_by_idempotency(idem_key)
    if existing:
        _emit(state, "Purchase Agent", "idempotent_hit", {"idempotency_key": idem_key, "item": line.item})
        return PurchaseResult(
            status="confirmed",
            idempotency_key=idem_key,
            order_id=f"existing-{existing['id']}",
            message="Order already placed earlier. Returning idempotent result.",
        )

    retries = 3
    for attempt in range(1, retries + 1):
        try:
            # Simulate transient downstream issue.
            if random.random() < 0.2 and attempt < retries:
                raise RuntimeError("Transient vendor timeout")
            order_id = create_order(
                thread_id=state.get("thread_id", ""),
                user_id=user_id,
                idempotency_key=idem_key,
                vendor=rec.vendor,
                item=rec.item_name,
                quantity=line.quantity,
                price_total=rec.unit_price * line.quantity,
                status="confirmed",
                request_text=state.get("user_text"),
                payment_method=state.get("payment_method"),
                payment_id=state.get("payment_id"),
            )
            _emit(state, "Purchase Agent", "line_confirmed", {"item": line.item, "order_id": order_id, "attempt": attempt})
            return PurchaseResult(
                status="confirmed",
                idempotency_key=idem_key,
                order_id=f"ORD-{order_id}",
                message="Order placed successfully.",
            )
        except Exception as exc:
            _emit(state, "Purchase Agent", "retrying", {"item": line.item, "attempt": attempt, "error": str(exc)})
            time.sleep(0.3)

    return PurchaseResult(status="failed", idempotency_key=idem_key, message=f"{line.item}: purchase failed after retries")


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
            "lines": [line.model_dump() for line in decision.lines],
            "total": sum(line.option.unit_price * line.quantity for line in decision.lines if line.option),
        }
    )

    approved = bool(approval.get("approved", False)) if isinstance(approval, dict) else bool(approval)
    selections = approval.get("selections", {}) if isinstance(approval, dict) else {}
    # Payment picked on the approval card, else the profile's preferred method.
    payment_method = (approval.get("payment_method") if isinstance(approval, dict) else None) or state.get("payment_method")
    payment_id = approval.get("payment_id") if isinstance(approval, dict) else None
    state = {**state, "payment_method": payment_method, "payment_id": payment_id}
    for index, line in enumerate(decision.lines):
        # The buyer's pick from the options shown at approval (keys may arrive as strings).
        choice = selections.get(index, selections.get(str(index)))
        if isinstance(choice, int) and 0 <= choice < len(line.options):
            line.option = line.options[choice]
    if not approved:
        declined = PurchaseResult(status="skipped", message="Order cancelled by user confirmation")
        _emit(state, "Purchase Agent", "agent_completed", {"purchase": declined.model_dump()})
        return {"purchase": declined.model_dump(), "approved": False}

    if not decision.lines:
        failed = PurchaseResult(status="failed", message="Missing recommendation details")
        _emit(state, "Purchase Agent", "agent_failed", {"purchase": failed.model_dump()})
        return {"purchase": failed.model_dump(), "approved": True}

    results = [_place_line(state, i, line) for i, line in enumerate(decision.lines)]
    order_ids = [r.order_id for r in results if r.order_id]
    failures = [r.message for r in results if r.status != "confirmed"]
    purchase = PurchaseResult(
        status="failed" if failures else "confirmed",
        idempotency_key=results[0].idempotency_key,
        order_id=order_ids[0] if order_ids else None,
        order_ids=order_ids,
        message="; ".join(failures) if failures else "Order placed successfully.",
    )
    _emit(
        state,
        "Purchase Agent",
        "agent_failed" if failures else "agent_completed",
        {"purchase": purchase.model_dump()},
    )
    # Save the buyer's picks so the notification and order summary show what was actually bought.
    return {
        "purchase": purchase.model_dump(),
        "approved": True,
        "decision": decision.model_dump(),
        "payment_method": payment_method,
        "payment_id": payment_id,
    }


def notification_agent(state: MitraGraphState) -> MitraGraphState:
    _emit(state, "Notification Agent", "agent_started", {})
    plan = PlanResult(**state.get("plan", {"ready_for_search": True}))
    decision = DecisionResult(**state.get("decision", {"reasoning": ""}))
    purchase = PurchaseResult(**state.get("purchase", {"status": "skipped", "message": "No purchase"}))

    if not plan.ready_for_search:
        result = NotificationResult(
            user_message=plan.clarification_question or "Please share item details.",
            family_webhook_status="skipped",
        )
        _emit(state, "Notification Agent", "agent_completed", {"notification": result.model_dump()})
        return {"notification": result.model_dump()}

    picked = [line for line in decision.lines if line.option]
    alerts: list[AlertResult] = []
    if purchase.status == "confirmed":
        summary = ", ".join(f"{line.quantity} x {line.option.item_name} ({line.option.vendor})" for line in picked)
        eta = max((line.option.eta_minutes for line in picked), default=0)
        msg_seed = f"Order confirmed: {summary or 'items'} with ETA {eta or '?'} min."
        msg = generate_notification_with_llm(msg_seed) or msg_seed
        alerts = _send_alerts(state, picked, eta)
        family_told = sorted({a.who for a in alerts if a.status == "sent" and a.who != "you"})
        if family_told:
            msg += f" I've also let {', '.join(family_told)} know."
        webhook = "sent" if family_told else "skipped"
    elif purchase.status == "skipped":
        msg_seed = "Okay, the order has been cancelled. Just ask whenever you want to order again."
        msg = generate_notification_with_llm(msg_seed) or msg_seed
        webhook = "skipped"
    else:
        msg_seed = "The order could not be placed. I can try again right away."
        msg = generate_notification_with_llm(msg_seed) or msg_seed
        webhook = "skipped"

    result = NotificationResult(user_message=msg, family_webhook_status=webhook, alerts=alerts)
    _emit(state, "Notification Agent", "agent_completed", {"notification": result.model_dump()})
    return {"notification": result.model_dump()}


PAYMENT_TEXT = {"cod": "cash on delivery", "upi_on_delivery": "UPI on delivery", "online": "paid online"}


def _send_alerts(state: MitraGraphState, picked: list[OrderLine], eta: int) -> list[AlertResult]:
    """Email / SMS the user and their family; a failure here never undoes the order."""
    try:
        profile = UserProfile(**state.get("user_profile", {}))
    except Exception:
        return []
    summary = ", ".join(f"{line.quantity} x {line.option.item_name}" for line in picked if line.option)
    total = sum(line.option.unit_price * line.quantity for line in picked if line.option)
    payment = PAYMENT_TEXT.get(state.get("payment_method") or "", "pay on delivery")
    results = send_order_alerts(profile, summary, total, payment, eta)
    if results:
        _emit(state, "Notification Agent", "alerts_sent", {"alerts": [r.model_dump() for r in results]})
    return results
