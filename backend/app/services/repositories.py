from __future__ import annotations

from datetime import datetime
from typing import Any
from sqlalchemy import select

from app.core.db import SessionLocal, audit_logs, orders, payments, user_profiles
from app.schemas import OrderHistoryEntry, OrderHistoryLine, ProfileFields, UserProfile


def get_user_profile(user_id: str) -> UserProfile:
    with SessionLocal() as session:
        row = session.execute(select(user_profiles).where(user_profiles.c.id == user_id)).mappings().first()
        if not row:
            raise ValueError(f"User profile {user_id} not found")
        # Rows from before sign-in only have name/age/conditions/preferences; the rest fall back to defaults.
        fields = {k: row[k] for k in ProfileFields.model_fields if k in row and row[k] is not None}
        return UserProfile(id=str(row["id"]), preferences=dict(row["preferences"] or {}), **fields)


def save_user_profile(user_id: str, fields: ProfileFields) -> UserProfile:
    values = fields.model_dump()
    with SessionLocal() as session:
        exists = session.execute(select(user_profiles.c.id).where(user_profiles.c.id == user_id)).first()
        if exists:
            session.execute(
                user_profiles.update().where(user_profiles.c.id == user_id).values(**values, updated_at=datetime.utcnow())
            )
        else:
            session.execute(user_profiles.insert().values(id=user_id, preferences={}, **values))
        session.commit()
    return get_user_profile(user_id)


def list_orders(user_id: str, limit: int = 30) -> list[OrderHistoryEntry]:
    """The user's placed orders, one entry per approval (order lines grouped by thread)."""
    with SessionLocal() as session:
        rows = (
            session.execute(
                select(orders).where(orders.c.user_id == user_id).order_by(orders.c.created_at.desc(), orders.c.id.desc())
            )
            .mappings()
            .all()
        )
    grouped: dict[str, OrderHistoryEntry] = {}
    for row in rows:
        entry = grouped.get(row["thread_id"])
        if entry is None:
            if len(grouped) >= limit:
                continue
            entry = grouped[row["thread_id"]] = OrderHistoryEntry(
                thread_id=row["thread_id"],
                request_text=row["request_text"],
                created_at=row["created_at"].isoformat() + "Z",
                status=row["status"],
                payment_method=row["payment_method"],
                total=0,
                lines=[],
            )
        entry.lines.append(
            OrderHistoryLine(item=row["item"], vendor=row["vendor"], quantity=row["quantity"], price_total=row["price_total"])
        )
        entry.total += row["price_total"]
    return list(grouped.values())


def write_audit_log(
    thread_id: str,
    event_type: str,
    agent_name: str,
    payload: dict[str, Any],
    success: bool = True,
    message: str | None = None,
) -> None:
    with SessionLocal() as session:
        session.execute(
            audit_logs.insert().values(
                thread_id=thread_id,
                event_type=event_type,
                agent_name=agent_name,
                payload=payload,
                success=success,
                message=message,
            )
        )
        session.commit()


def get_order_by_idempotency(idempotency_key: str):
    with SessionLocal() as session:
        return session.execute(select(orders).where(orders.c.idempotency_key == idempotency_key)).mappings().first()


def create_order(
    thread_id: str,
    user_id: str,
    idempotency_key: str,
    vendor: str,
    item: str,
    quantity: int,
    price_total: int,
    status: str,
    request_text: str | None = None,
    payment_method: str | None = None,
    payment_id: str | None = None,
) -> int:
    with SessionLocal() as session:
        result = session.execute(
            orders.insert().values(
                thread_id=thread_id,
                user_id=user_id,
                idempotency_key=idempotency_key,
                vendor=vendor,
                item=item,
                quantity=quantity,
                price_total=price_total,
                status=status,
                request_text=request_text,
                payment_method=payment_method,
                payment_id=payment_id,
            )
        )
        session.commit()
        return int(result.inserted_primary_key[0])


def get_payment(thread_id: str):
    with SessionLocal() as session:
        return session.execute(select(payments).where(payments.c.thread_id == thread_id)).mappings().first()


def save_payment(thread_id: str, user_id: str, razorpay_order_id: str, amount_paise: int, selections: dict[int, int]) -> None:
    """Records the Razorpay order for this thread, replacing an unpaid earlier one (picks changed)."""
    with SessionLocal() as session:
        session.execute(payments.delete().where(payments.c.thread_id == thread_id, payments.c.status == "created"))
        session.execute(
            payments.insert().values(
                thread_id=thread_id,
                user_id=user_id,
                razorpay_order_id=razorpay_order_id,
                amount_paise=amount_paise,
                currency="INR",
                selections={str(k): v for k, v in selections.items()},
                status="created",
            )
        )
        session.commit()


def update_payment(thread_id: str, **values: Any) -> None:
    with SessionLocal() as session:
        session.execute(payments.update().where(payments.c.thread_id == thread_id).values(**values, updated_at=datetime.utcnow()))
        session.commit()
