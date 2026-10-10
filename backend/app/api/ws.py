from __future__ import annotations

import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from fastapi.concurrency import run_in_threadpool

from app.core.auth import websocket_user_id
from app.graph.workflow import thread_owner
from app.services.redis_bus import redis_bus

router = APIRouter(tags=["ws"])


@router.websocket("/ws/events/{thread_id}")
async def ws_events(websocket: WebSocket, thread_id: str) -> None:
    user_id = await run_in_threadpool(websocket_user_id, websocket)
    if user_id is None or await run_in_threadpool(thread_owner, thread_id) != user_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
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
            # Nothing more can arrive without Redis; closing (instead of idling) lets the
            # server reload and shut down without waiting on this socket.
            await websocket.close()
            return
        pubsub.subscribe(channel)
        # Watch for the browser leaving (or the server shutting down) while relaying events.
        client_gone = asyncio.create_task(websocket.receive())
        try:
            while not client_gone.done():
                # Non-blocking poll: a blocking get_message() would stall every other request.
                message = pubsub.get_message(timeout=0)
                if message and message.get("type") == "message":
                    data = message.get("data")
                    if isinstance(data, str):
                        await websocket.send_text(data)
                await asyncio.sleep(0.1)
        finally:
            client_gone.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        try:
            pubsub.unsubscribe(channel)
            pubsub.close()
        except Exception:
            pass
