from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.concurrency import run_in_threadpool

from app.core.auth import current_user_id, websocket_user_id

from app.services.speech_to_text import SpeechUnavailable, StreamingTranscriber, engine_name, transcribe

router = APIRouter(prefix="/api/v1/voice", tags=["voice"])

# ~5 minutes of 16 kHz 16-bit mono audio.
MAX_AUDIO_BYTES = 10 * 1024 * 1024


@router.get("/status")
def voice_status() -> dict[str, str | None]:
    return {"server_engine": engine_name()}


@router.post("/transcribe")
async def transcribe_audio(request: Request, _user_id: str = Depends(current_user_id)) -> dict[str, str]:
    """Body: raw 16-bit mono WAV (Content-Type: audio/wav)."""
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="No audio received")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Recording too long")
    try:
        text, engine = await run_in_threadpool(transcribe, audio)
    except SpeechUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"text": text, "engine": engine}


@router.websocket("/stream")
async def stream_audio(websocket: WebSocket) -> None:
    """Live transcription. Client sends binary frames of 16 kHz 16-bit mono PCM
    while recording, then the text frame "end". Server replies with
    {"type": "partial", "text"} as words are recognised and one
    {"type": "final", "text"} after "end"."""
    if await run_in_threadpool(websocket_user_id, websocket) is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await websocket.accept()
    try:
        transcriber = await run_in_threadpool(StreamingTranscriber)
    except SpeechUnavailable as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close()
        return

    received = 0
    last_partial = ""
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            chunk = message.get("bytes")
            if chunk:
                received += len(chunk)
                if received > MAX_AUDIO_BYTES:
                    break
                text = await run_in_threadpool(transcriber.feed, chunk)
                if text != last_partial:
                    last_partial = text
                    await websocket.send_json({"type": "partial", "text": text})
            elif message.get("text") == "end":
                break
        final = await run_in_threadpool(transcriber.finish)
        await websocket.send_json({"type": "final", "text": final})
        await websocket.close()
    except WebSocketDisconnect:
        pass
