"""Curated synthetic voices and independently cached five-second reference samples."""

import asyncio
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import edge_tts

from media import ConversionCancelled, check_cancel, ffmpeg

logger = logging.getLogger(__name__)
REFS = Path(__file__).parent / "refs"
SAMPLES = REFS / "samples"
SAMPLES.mkdir(parents=True, exist_ok=True)
SAMPLE_SECONDS = 5
SAMPLE_TEXT = "Welcome to your voice studio. Let's make something great together."


@dataclass(frozen=True)
class Voice:
    id: str
    name: str
    style: str
    description: str
    accent: str
    gender: str
    color: str
    speakers: tuple[str, ...]


VOICE_LIST = (
    Voice("male", "Arjun", "Warm narrator", "Grounded and reassuring. A natural fit for tutorials.",
          "Indian", "male", "amber", ("en-IN-PrabhatNeural", "hi-IN-MadhurNeural")),
    Voice("female", "Ananya", "Expressive guide", "Warm, articulate, and easy to listen to.",
          "Indian", "female", "rose", ("en-IN-NeerjaNeural", "hi-IN-SwaraNeural")),
    Voice("american_male", "Miles", "Deep storyteller", "A rich, relaxed tone for stories and explainers.",
          "American", "male", "indigo", ("en-US-GuyNeural",)),
    Voice("american_female", "Clara", "Bright conversational", "Friendly and lively, with a clear delivery.",
          "American", "female", "cyan", ("en-US-JennyNeural",)),
    Voice("british_male", "Oliver", "Polished presenter", "Measured and confident for presentations.",
          "British", "male", "violet", ("en-GB-RyanNeural",)),
    Voice("british_female", "Sophie", "Elegant storyteller", "Smooth and composed for thoughtful narration.",
          "British", "female", "pink", ("en-GB-SoniaNeural",)),
    Voice("australian_male", "Leo", "Easygoing host", "An approachable voice with a relaxed character.",
            "Australian", "male", "emerald", ("en-AU-WilliamMultilingualNeural",)),
    Voice("australian_female", "Isla", "Clear educator", "Open and clear for lessons and everyday content.",
          "Australian", "female", "sky", ("en-AU-NatashaNeural",)),
)
VOICES = {voice.id: voice for voice in VOICE_LIST}
_sample_locks: dict[str, asyncio.Lock] = {}


def catalog() -> list[dict]:
    return [{
        "id": voice.id, "name": voice.name, "label": f"{voice.name} · {voice.style}",
        "style": voice.style, "description": voice.description, "accent": voice.accent,
        "gender": voice.gender, "color": voice.color,
        "languages": ["English", "Hindi"] if voice.accent == "Indian" else ["English"],
        "sample_url": f"/api/voices/{voice.id}/sample?v=1",
        "sample_seconds": SAMPLE_SECONDS,
        "sample_ready": (SAMPLES / f"{voice.id}.wav").exists(),
        "reference_ready": (REFS / f"{voice.id}.pt").exists(),
    } for voice in VOICE_LIST]


async def synthesize(text: str, speaker: str, destination: Path,
                     cancel: threading.Event | None = None) -> None:
    """Bound external requests and retry transient TTS failures, not forever."""

    async def save() -> None:
        request = asyncio.create_task(edge_tts.Communicate(text, speaker).save(str(destination)))
        try:
            while not request.done():
                check_cancel(cancel)
                await asyncio.wait({request}, timeout=0.25)
            await request
        finally:
            if not request.done():
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)

    for attempt in range(3):
        check_cancel(cancel)
        try:
            await asyncio.wait_for(save(), timeout=45)
            return
        except ConversionCancelled:
            raise
        except Exception as exc:
            if attempt == 2:
                raise RuntimeError("The voice service is unavailable. Check your internet connection and retry.") from exc
            await asyncio.sleep(0.5 * (attempt + 1))


async def ensure_sample(voice_id: str) -> Path:
    voice = VOICES[voice_id]
    destination = SAMPLES / f"{voice_id}.wav"
    if destination.exists():
        return destination
    lock = _sample_locks.setdefault(voice_id, asyncio.Lock())
    async with lock:
        if destination.exists():
            return destination
        token = uuid4().hex
        mp3 = SAMPLES / f"{token}.mp3"
        temporary = SAMPLES / f"{token}.wav"
        try:
            await synthesize(SAMPLE_TEXT, voice.speakers[0], mp3)
            await asyncio.to_thread(ffmpeg, [
                "-i", str(mp3), "-af", "apad", "-t", str(SAMPLE_SECONDS),
                "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(temporary),
            ])
            temporary.replace(destination)
        finally:
            mp3.unlink(missing_ok=True)
            temporary.unlink(missing_ok=True)
    return destination


async def prepare_samples() -> None:
    limit = asyncio.Semaphore(3)

    async def prepare(voice_id: str) -> None:
        async with limit:
            try:
                await ensure_sample(voice_id)
            except Exception as exc:
                logger.warning("Sample for %s is not ready: %s", voice_id, exc)

    await asyncio.gather(*(prepare(voice.id) for voice in VOICE_LIST))