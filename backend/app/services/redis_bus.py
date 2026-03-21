from __future__ import annotations

import json
from typing import Any
from redis import Redis

from app.core.config import settings


class RedisBus:
    def __init__(self) -> None:
        self._redis: Redis | None = None

    @property
    def client(self) -> Redis:
        if self._redis is None:
            self._redis = Redis.from_url(settings.redis_url, decode_responses=True)
        return self._redis

    def publish_event(self, thread_id: str, payload: dict[str, Any]) -> None:
        channel = f"mitra:events:{thread_id}"
        data = json.dumps(payload)
        try:
            self.client.rpush(channel, data)
            self.client.expire(channel, 3600)
            self.client.publish(channel, data)
        except Exception:
            # Keep execution resilient even if Redis is unavailable.
            pass

    def history(self, thread_id: str) -> list[dict[str, Any]]:
        channel = f"mitra:events:{thread_id}"
        try:
            rows = self.client.lrange(channel, 0, -1)
            return [json.loads(r) for r in rows]
        except Exception:
            return []

    def get_pubsub(self):
        try:
            return self.client.pubsub()
        except Exception:
            return None


redis_bus = RedisBus()
