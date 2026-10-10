"""Server-side speech-to-text, used when the browser has no speech recognition
of its own (Firefox, Brave, some in-app browsers). The browser records the
mic, converts it to a 16 kHz mono WAV and posts it here.

Engines, best first:
  - OpenAI transcription, when OPENAI_API_KEY is set (handles mixed Hindi/English best)
  - Vosk, offline and free, using the small Hindi and Indian-English models in backend/models/
"""

from __future__ import annotations

import io
import json
import threading
import wave
from pathlib import Path

from app.core.config import settings
from app.services.voice_text import understood_ratio

_vosk_models: dict[str, object] = {}
_vosk_lock = threading.Lock()


class SpeechUnavailable(RuntimeError):
    """No speech engine is configured on the server."""


def _vosk_model_dirs() -> list[Path]:
    root = Path(settings.vosk_models_dir)
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir() and p.name.startswith("vosk-model"))


def engine_name() -> str | None:
    if settings.openai_api_key:
        return "openai"
    if _vosk_model_dirs():
        return "vosk"
    return None


def _load_vosk(path: Path):
    with _vosk_lock:
        if str(path) not in _vosk_models:
            from vosk import Model, SetLogLevel

            SetLogLevel(-1)
            _vosk_models[str(path)] = Model(str(path))
    return _vosk_models[str(path)]


def _read_wav(wav_bytes: bytes) -> tuple[bytes, int]:
    try:
        wav = wave.open(io.BytesIO(wav_bytes), "rb")
    except (wave.Error, EOFError) as exc:
        raise ValueError("Audio must be a WAV file") from exc
    with wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("Expected 16-bit mono WAV audio")
        return wav.readframes(wav.getnframes()), wav.getframerate()


def _run_vosk(model_dir: Path, pcm: bytes, rate: int) -> tuple[str, float]:
    """(text, mean word confidence) from one Vosk model."""
    from vosk import KaldiRecognizer

    recognizer = KaldiRecognizer(_load_vosk(model_dir), rate)
    recognizer.SetWords(True)
    words: list[dict] = []
    for start in range(0, len(pcm), 8000):
        if recognizer.AcceptWaveform(pcm[start : start + 8000]):
            words += json.loads(recognizer.Result()).get("result", [])
    words += json.loads(recognizer.FinalResult()).get("result", [])
    text = " ".join(w["word"] for w in words)
    confidence = sum(w.get("conf", 0.0) for w in words) / len(words) if words else 0.0
    return text, confidence


def _transcribe_vosk(wav_bytes: bytes) -> str:
    """Runs every installed model (Hindi and Indian-English) and keeps the transcript Mitra understands best.

    The Hindi model hears Hindi/Hinglish well but mangles English sentences;
    the English model is the opposite. Neither knows which language was
    spoken, so the winner is the transcript with the most recognisable
    grocery words, numbers and units, with model confidence as a tie-break.
    """
    pcm, rate = _read_wav(wav_bytes)
    best_text, best_score = "", -1.0
    for model_dir in _vosk_model_dirs():
        text, confidence = _run_vosk(model_dir, pcm, rate)
        if not text:
            continue
        score = understood_ratio(text) * 0.7 + confidence * 0.3
        if score > best_score:
            best_text, best_score = text, score
    return best_text


STREAM_SAMPLE_RATE = 16_000


def _mean_conf(words: list[dict]) -> float:
    return sum(w.get("conf", 0.0) for w in words) / len(words) if words else 0.0


class StreamingTranscriber:
    """Live speech-to-text for one recording: feed 16 kHz 16-bit mono PCM as it
    arrives and get the best text so far back after every chunk.

    Every installed Vosk model listens at once (Hindi and Indian English); the
    text shown is the one Mitra understands best, same rule as _transcribe_vosk.
    Once a model is chosen it is kept unless another is clearly better, so the
    live text doesn't flicker between scripts while the user is mid-sentence.
    """

    SWITCH_MARGIN = 0.15

    def __init__(self) -> None:
        from vosk import KaldiRecognizer

        dirs = _vosk_model_dirs()
        if not dirs:
            raise SpeechUnavailable("Live speech-to-text needs the Vosk models in backend/models/ (see README).")
        self._streams: list[dict] = []
        for model_dir in dirs:
            recognizer = KaldiRecognizer(_load_vosk(model_dir), STREAM_SAMPLE_RATE)
            recognizer.SetWords(True)
            self._streams.append({"rec": recognizer, "words": [], "partial": ""})
        self._chosen: int | None = None

    def feed(self, pcm: bytes) -> str:
        for stream in self._streams:
            rec = stream["rec"]
            if rec.AcceptWaveform(pcm):
                stream["words"] += json.loads(rec.Result()).get("result", [])
                stream["partial"] = ""
            else:
                stream["partial"] = json.loads(rec.PartialResult()).get("partial", "")
        return self._best()

    def finish(self) -> str:
        for stream in self._streams:
            stream["words"] += json.loads(stream["rec"].FinalResult()).get("result", [])
            stream["partial"] = ""
        return self._best()

    @staticmethod
    def _text(stream: dict) -> str:
        return " ".join([*(w["word"] for w in stream["words"]), stream["partial"]]).strip()

    def _best(self) -> str:
        scores = []
        for stream in self._streams:
            text = self._text(stream)
            scores.append(understood_ratio(text) * 0.7 + _mean_conf(stream["words"]) * 0.3 if text else -1.0)
        leader = max(range(len(scores)), key=scores.__getitem__)
        if self._chosen is None or scores[leader] > scores[self._chosen] + self.SWITCH_MARGIN:
            self._chosen = leader
        return self._text(self._streams[self._chosen])


def _transcribe_openai(wav_bytes: bytes) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key)
    result = client.audio.transcriptions.create(
        model="gpt-4o-mini-transcribe",
        file=("speech.wav", wav_bytes, "audio/wav"),
        prompt="Grocery order from an elderly Indian user, in Hindi, English or Hinglish.",
    )
    return (result.text or "").strip()


def transcribe(wav_bytes: bytes) -> tuple[str, str]:
    """Returns (text, engine used)."""
    engine = engine_name()
    if engine == "openai":
        try:
            return _transcribe_openai(wav_bytes), "openai"
        except Exception:
            if not _vosk_model_dirs():
                raise
            engine = "vosk"  # fall back to the offline model
    if engine == "vosk":
        return _transcribe_vosk(wav_bytes), "vosk"
    raise SpeechUnavailable(
        "Server speech-to-text is not set up. Set OPENAI_API_KEY or download the Vosk models "
        "into backend/models/ (see README)."
    )
