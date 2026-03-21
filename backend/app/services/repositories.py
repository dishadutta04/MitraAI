from __future__ import annotations

from typing import Any
from sqlalchemy import select

from app.core.db import SessionLocal, audit_logs, orders, user_profiles
from app.schemas import UserProfile


def get_user_profile(user_id: str) -> UserProfile:
    with SessionLocal() as session:
        row = session.execute(select(user_profiles).where(user_profiles.c.id == user_id)).mappings().first()
        if not row:
            raise ValueError(f"User profile {user_id} not found")
        return UserProfile(
            id=str(row["id"]),
            name=str(row["name"]),
            age=int(row["age"]),
            conditions=list(row["conditions"] or []),
            preferences=dict(row["preferences"] or {}),
        )


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
            )
        )
        session.commit()
        return int(result.inserted_primary_key[0])
