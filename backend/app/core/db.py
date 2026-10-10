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
    inspect,
    text,
)
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

# Supabase (or any Postgres) via DATABASE_URL; pre-ping drops connections the pooler has closed.
engine = create_engine(settings.database_url, future=True, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
metadata = MetaData()

# One row per Clerk user (id = Clerk user id), filled in by the onboarding steps.
user_profiles = Table(
    "user_profiles",
    metadata,
    Column("id", String(64), primary_key=True),
    Column("name", String(120), nullable=False),
    Column("age", Integer, nullable=False),
    Column("conditions", JSON, nullable=False),
    Column("preferences", JSON, nullable=False),
    Column("created_at", DateTime, default=datetime.utcnow, nullable=False),
    # Columns below were added with sign-in; nullable so existing databases can gain them.
    Column("phone", String(32), nullable=True),
    Column("address", Text, nullable=True),
    Column("language", String(16), nullable=True),
    Column("preferred_stores", JSON, nullable=True),
    Column("payment_method", String(32), nullable=True),
    Column("allergies", JSON, nullable=True),
    Column("medications", JSON, nullable=True),
    Column("diet_notes", Text, nullable=True),
    Column("family_contacts", JSON, nullable=True),
    Column("voice", JSON, nullable=True),
    Column("onboarding_completed", Boolean, nullable=True, default=False),
    Column("updated_at", DateTime, nullable=True, default=datetime.utcnow, onupdate=datetime.utcnow),
    Column("email", String(200), nullable=True),
    Column("alerts", JSON, nullable=True),
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
    Column("request_text", Text, nullable=True),
    Column("payment_method", String(32), nullable=True),
    Column("payment_id", String(64), nullable=True),
)

# One online payment per order thread: the Razorpay order, the amount it was created for, and the
# option picks that amount covers (the purchase uses these picks, so what's paid is what's bought).
payments = Table(
    "payments",
    metadata,
    Column("thread_id", String(120), primary_key=True),
    Column("user_id", String(64), nullable=False),
    Column("razorpay_order_id", String(64), nullable=False, unique=True),
    Column("amount_paise", Integer, nullable=False),
    Column("currency", String(8), nullable=False, default="INR"),
    Column("selections", JSON, nullable=False),
    # created → paid → (refunded | refund_failed if the purchase fails after payment)
    Column("status", String(32), nullable=False, default="created"),
    Column("razorpay_payment_id", String(64), nullable=True),
    Column("created_at", DateTime, default=datetime.utcnow, nullable=False),
    Column("updated_at", DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True),
)


def init_db() -> None:
    metadata.create_all(bind=engine)
    _add_missing_columns()
    _lock_down_supabase_tables()


def _lock_down_supabase_tables() -> None:
    """On Postgres (Supabase), turn on row level security with no policies: Supabase's public
    API (anon / authenticated keys) then can't read health data; only this backend's
    direct database connection can."""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        for table in metadata.sorted_tables:
            conn.execute(text(f"ALTER TABLE {table.name} ENABLE ROW LEVEL SECURITY"))


def _add_missing_columns() -> None:
    """create_all doesn't alter existing tables, so add columns introduced since they were created."""
    existing_tables = inspect(engine).get_table_names()
    with engine.begin() as conn:
        for table in metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            present = {c["name"] for c in inspect(conn).get_columns(table.name)}
            for column in table.columns:
                if column.name not in present:
                    col_type = column.type.compile(dialect=engine.dialect)
                    conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{column.name}" {col_type}'))
