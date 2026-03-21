from __future__ import annotations

from datetime import datetime
from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
)
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

engine = create_engine(settings.database_url, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
metadata = MetaData()

user_profiles = Table(
    "user_profiles",
    metadata,
    Column("id", String(64), primary_key=True),
    Column("name", String(120), nullable=False),
    Column("age", Integer, nullable=False),
    Column("conditions", JSON, nullable=False),
    Column("preferences", JSON, nullable=False),
    Column("created_at", DateTime, default=datetime.utcnow, nullable=False),
)

audit_logs = Table(
    "audit_logs",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("thread_id", String(120), nullable=False),
    Column("event_type", String(64), nullable=False),
    Column("agent_name", String(64), nullable=False),
    Column("payload", JSON, nullable=False),
    Column("success", Boolean, nullable=False, default=True),
    Column("message", Text, nullable=True),
    Column("created_at", DateTime, default=datetime.utcnow, nullable=False),
)

orders = Table(
    "orders",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("thread_id", String(120), nullable=False),
    Column("user_id", String(64), nullable=False),
    Column("idempotency_key", String(120), nullable=False, unique=True),
    Column("vendor", String(32), nullable=False),
    Column("item", String(120), nullable=False),
    Column("quantity", Integer, nullable=False),
    Column("price_total", Integer, nullable=False),
    Column("status", String(32), nullable=False),
    Column("created_at", DateTime, default=datetime.utcnow, nullable=False),
)


def init_db() -> None:
    metadata.create_all(bind=engine)
    seed_default_profile()


def seed_default_profile() -> None:
    default_user_id = "dadaji-001"
    with engine.begin() as conn:
        row = conn.execute(user_profiles.select().where(user_profiles.c.id == default_user_id)).first()
        if row:
            return
        conn.execute(
            user_profiles.insert().values(
                id=default_user_id,
                name="Dadaji",
                age=75,
                conditions=["diabetes", "hypertension"],
                preferences={"delivery": "fast", "language": "hinglish"},
            )
        )
