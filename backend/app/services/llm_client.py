from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field

from app.core.config import settings

try:
    from langchain_openai import ChatOpenAI
except Exception:  # pragma: no cover - optional dependency behavior
    ChatOpenAI = None


def choose_model_name() -> str:
    if settings.llm_provider == "openai" and settings.openai_api_key:
        return "openai:gpt-4.1-mini"
    return "mock:rule-based"


class LLMIntent(BaseModel):
    item: str | None = None
    quantity: int = 1
    urgency: str = "medium"
    preferences: list[str] = Field(default_factory=list)


def _openai_client():
    if settings.llm_provider != "openai" or not settings.openai_api_key or ChatOpenAI is None:
        return None
    return ChatOpenAI(model="gpt-4.1-mini", temperature=0, api_key=settings.openai_api_key)


def parse_intent_with_llm(text: str) -> dict[str, Any] | None:
    client = _openai_client()
    if client is None:
        return None
    try:
        parser = client.with_structured_output(LLMIntent)
        prompt = (
            "Extract grocery intent from this user text. "
            "Return item, quantity, urgency(low|medium|high), preferences list. "
            f"Text: {text}"
        )
        result = parser.invoke(prompt)
        return result.model_dump()
    except Exception:
        return None


def generate_notification_with_llm(summary_seed: str) -> str | None:
    client = _openai_client()
    if client is None:
        return None
    try:
        prompt = (
            "You are Mitra AI talking to an elderly Indian user in simple comforting Hinglish. "
            "Rewrite this message in 1 short sentence, keep it warm and clear: "
            f"{summary_seed}"
        )
        response = client.invoke(prompt)
        return str(response.content).strip()
    except Exception:
        return None
