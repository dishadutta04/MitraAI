from __future__ import annotations

import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.redis_bus import redis_bus

router = APIRouter(tags=["ws"])


@router.websocket("/ws/events/{thread_id}")
async def ws_events(websocket: WebSocket, thread_id: str) -> None:
    await websocket.accept()

    for event in redis_bus.history(thread_id):
        await websocket.send_json(event)

    pubsub = redis_bus.get_pubsub()
    channel = f"mitra:events:{thread_id}"

    try:
        if pubsub is None:
            await websocket.send_json(
                {
                    "event": "ws_warning",
                    "agent_name": "System",
                    "data": {"message": "Redis unavailable, live stream limited"},
                    "thread_id": thread_id,
                }
            )
            while True:
                await asyncio.sleep(1.0)
        pubsub.subscribe(channel)
        while True:
            message = pubsub.get_message(timeout=1.0)
            if message and message.get("type") == "message":
                data = message.get("data")
                if isinstance(data, str):
                    await websocket.send_text(data)
            await asyncio.sleep(0.05)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            pubsub.unsubscribe(channel)
            pubsub.close()
        except Exception:
            pass
