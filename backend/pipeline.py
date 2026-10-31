"""Memory-bounded kNN-VC with exact cosine search and reusable source features.

No transcription or text re-synthesis: preserve source timing and convert timbre.
Only the six WavLM layers actually used by kNN-VC are retained in memory.
"""
import asyncio
import gc
import hashlib
import logging
import os
import pickle
import shutil
import tempfile
import threading
import time
import wave
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torch.nn.functional as F

from engine import load_model, vocoder_window
from media import SR, check_cancel, decode_audio, ffmpeg, pcm16, write_wav
from voices import REFS, VOICES, synthesize

logger = logging.getLogger(__name__)
HOP = 320
CHUNK = 12 * SR
CTX = SR
CACHE = Path(__file__).parent / "cache" / "sources"
CACHE.mkdir(parents=True, exist_ok=True)
CACHE_VERSION = "wavlm6-v2"
MAX_CACHE_BYTES = int(os.getenv("VOICE_CACHE_MB", "2048")) * 1024 ** 2
MAX_DURATION_SECONDS = 60 * 60
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
THREADS = max(1, min(int(os.getenv("VOICE_THREADS", str(os.cpu_count() or 4))), 12))
torch.set_num_threads(THREADS)
QUALITY_MODES = {
    "fast": {"label": "Fast", "max_frames": 6000, "description": "Compact reference search. Quicker voice matching."},
    "studio": {"label": "Studio", "max_frames": None, "description": "Full reference coverage. Best voice detail."},
}

EN_TEXT = [
    "Welcome to this tutorial. Today we are going to learn something new, step by step. First, open the application on your computer and take a look at the main screen. You will see a menu at the top, a panel on the left, and a large working area in the middle.",
    "Let me explain how this works. When you click the button, the program reads the file, checks every line, and then shows the result on the screen. If there is an error, a red message appears, so please read it carefully before you continue.",
    "Now, type the name of your project and press enter. Wait for a few seconds while everything loads. Great! You can see that twenty five files were created, and the total size is about three point five megabytes.",
    "Remember, practice is the key to learning. Try it yourself, change the values, and see what happens. Don't worry if you make a mistake, because that is how we all learn. Why not try one more example together?",
    "Next, let's save our work. Go to the file menu, choose save as, and pick a folder that is easy to find. Quickly name the file, double check the spelling, and then click the save button at the bottom right corner of the window.",
    "Thank you so much for watching. I hope this video was useful for you. If you have any questions, please write them down, and we will go through them in the next session. Until then, keep practicing, stay curious, and see you very soon.",
    "There are three important things to remember. One, always back up your data. Two, test your changes on a small example before using them on the real project. Three, read the documentation, because it often answers questions you did not even know you had.",
    "Let us now look at the settings. Open the options window, scroll down slowly, and find the section called advanced. Here you can change the language, the theme, and the folder where the downloaded files are stored. Choose what works best for you.",
]
HI_TEXT = [
    "नमस्कार दोस्तों, आज के इस वीडियो में हम कुछ नया सीखने वाले हैं। सबसे पहले अपने कंप्यूटर पर एप्लिकेशन खोलिए और मुख्य स्क्रीन को ध्यान से देखिए। ऊपर एक मेनू है, बाईं तरफ एक पैनल है, और बीच में काम करने की बड़ी जगह है।",
    "अब मैं समझाता हूँ कि यह कैसे काम करता है। जब आप बटन दबाते हैं, तो प्रोग्राम फ़ाइल को पढ़ता है, हर पंक्ति की जाँच करता है, और नतीजा स्क्रीन पर दिखा देता है। अगर कोई गलती हो, तो लाल रंग का संदेश आएगा, उसे ध्यान से पढ़िए।",
    "अपने प्रोजेक्ट का नाम लिखिए और एंटर दबाइए। कुछ सेकंड इंतज़ार कीजिए जब तक सब कुछ लोड हो जाए। बहुत बढ़िया! आप देख सकते हैं कि पच्चीस फ़ाइलें बन गई हैं और कुल आकार लगभग साढ़े तीन मेगाबाइट है।",
    "याद रखिए, अभ्यास ही सीखने की कुंजी है। खुद करके देखिए, मान बदलिए, और देखिए क्या होता है। गलती हो जाए तो घबराइए मत, क्योंकि हम सब ऐसे ही सीखते हैं। चलिए, एक और उदाहरण साथ में करके देखते हैं।",
    "अब हम अपना काम सेव करेंगे। फ़ाइल मेनू में जाइए, सेव एज़ चुनिए, और कोई ऐसा फ़ोल्डर चुनिए जो आसानी से मिल जाए। फ़ाइल का नाम लिखिए, वर्तनी दोबारा जाँचिए, और खिड़की के नीचे दाईं ओर सेव बटन दबाइए।",
    "वीडियो देखने के लिए आप सभी का बहुत-बहुत धन्यवाद। मुझे उम्मीद है कि यह वीडियो आपके लिए उपयोगी रहा होगा। अगर आपके कोई सवाल हों तो उन्हें लिख लीजिए, अगले सत्र में हम उन पर बात करेंगे। तब तक अभ्यास करते रहिए, और जल्दी मिलते हैं।",
    "तीन बातें हमेशा याद रखिए। पहली, अपना डेटा हमेशा सुरक्षित रखिए। दूसरी, असली काम पर बदलाव करने से पहले उन्हें छोटे उदाहरण पर आज़माइए। तीसरी, दस्तावेज़ ज़रूर पढ़िए, क्योंकि उनमें अक्सर वे जवाब मिल जाते हैं जिनके बारे में आपने सोचा भी नहीं था।",
    "अब सेटिंग्स देखते हैं। विकल्प वाली खिड़की खोलिए, धीरे-धीरे नीचे जाइए, और उन्नत नाम का हिस्सा ढूँढिए। यहाँ आप भाषा, थीम, और वह फ़ोल्डर बदल सकते हैं जहाँ डाउनलोड की गई फ़ाइलें रखी जाती हैं। जो आपके लिए ठीक हो, वही चुनिए।",
]
REF_TEXT = {"en": EN_TEXT, "hi": HI_TEXT}

_knn = None
_knn_lock = threading.Lock()
_references: OrderedDict[str, torch.Tensor] = OrderedDict()
_indices: OrderedDict[tuple[str, str], "MatchingIndex"] = OrderedDict()
_job_lock = threading.Lock()
_warmup_error: str | None = None

Progress = Callable[[int, str], None]


@dataclass
class MatchingIndex:
    # Normalize only search vectors. The vocoder must receive ORIGINAL features.
    features: torch.Tensor
    normalized_t: torch.Tensor


def engine_info() -> dict:
    return {"device": DEVICE, "threads": THREADS, "ready": _knn is not None,
            "error": _warmup_error, "name": "kNN-VC · WavLM + HiFiGAN"}


def _model():
    global _knn
    with _knn_lock:
        if _knn is None:
            _knn = load_model(DEVICE)
            gc.collect()
        return _knn


def warmup() -> None:
    global _warmup_error
    try:
        _model()
        _warmup_error = None
    except Exception:
        _warmup_error = "Voice engine could not warm up. A conversion will retry initialization."
        logger.exception("Voice engine warmup failed")


@torch.inference_mode()
def _features(knn, audio: np.ndarray) -> torch.Tensor:
    x = torch.from_numpy(np.pad(audio, (0, 400)))[None].to(DEVICE)
    feats = knn.wavlm.extract_features(x, output_layer=6, ret_layer_results=False)[0]
    return feats.squeeze(0)


async def _make_reference_audio(voice_id: str, tmp: Path,
                                cancel: threading.Event | None) -> list[Path]:
    limit = asyncio.Semaphore(3)

    async def make(speaker: str, i: int, text: str) -> Path:
        async with limit:
            check_cancel(cancel)
            path = tmp / f"{speaker}_{i}.mp3"
            await synthesize(text, speaker, path, cancel=cancel)
            check_cancel(cancel)
            return path

    return await asyncio.gather(*(make(speaker, i, text)
                                 for speaker in VOICES[voice_id].speakers
                                 for i, text in enumerate(REF_TEXT[speaker[:2]])))


@torch.inference_mode()
def _matching_set(voice_id: str, progress: Progress,
                  cancel: threading.Event | None = None) -> torch.Tensor:
    if voice_id in _references:
        _references.move_to_end(voice_id)
        return _references[voice_id]
    cache = REFS / f"{voice_id}.pt"
    if cache.exists():
        ms = torch.load(cache, map_location="cpu", weights_only=True)
    else:
        progress(8, f"Preparing {VOICES[voice_id].name} once; future conversions use the cache…")
        with tempfile.TemporaryDirectory(prefix="voice-reference-") as temporary:
            clips = asyncio.run(_make_reference_audio(voice_id, Path(temporary), cancel))
            features = []
            for i, clip in enumerate(clips):
                check_cancel(cancel)
                features.append(_features(_model(), decode_audio(clip, cancel)).cpu())
                progress(8 + int((i + 1) / len(clips) * 10),
                         f"Preparing voice reference {i + 1}/{len(clips)} (one-time setup)…")
            ms = torch.cat(features, dim=0)
        temporary_cache = cache.with_suffix(".tmp")
        try:
            torch.save(ms, temporary_cache)
            temporary_cache.replace(cache)
        finally:
            temporary_cache.unlink(missing_ok=True)
    if not isinstance(ms, torch.Tensor) or ms.ndim != 2 or ms.shape[1] != 1024 or len(ms) < 4:
        raise RuntimeError(f"Invalid reference cache for {voice_id}. Remove its cache and retry.")
    ms = ms.float().contiguous()
    _references[voice_id] = ms
    while len(_references) > 2:
        _references.popitem(last=False)
    return ms


@torch.inference_mode()
def _index(voice_id: str, quality: str, progress: Progress,
           cancel: threading.Event | None) -> MatchingIndex:
    key = (voice_id, quality)
    if key in _indices:
        _indices.move_to_end(key)
        return _indices[key]
    features = _matching_set(voice_id, progress, cancel)
    maximum = QUALITY_MODES[quality]["max_frames"]
    if maximum is not None and len(features) > maximum:
        # Cover every reference clip deterministically, not just its first few seconds.
        positions = torch.linspace(0, len(features) - 1, maximum).long()
        features = features[positions]
    features = features.to(DEVICE)
    index = MatchingIndex(features, F.normalize(features, dim=-1).T.contiguous())
    _indices[key] = index
    while len(_indices) > 2:
        _indices.popitem(last=False)
    return index


@torch.inference_mode()
def match_features(features: torch.Tensor, index: MatchingIndex) -> torch.Tensor:
    """Exact cosine top-4 search; bound the distance matrix to 256 query frames."""
    matches = []
    for query in features.split(256):
        similarity = F.normalize(query, dim=-1) @ index.normalized_t
        neighbors = similarity.topk(4, dim=-1).indices
        matches.append(index.features[neighbors].mean(dim=1))
    return torch.cat(matches, dim=0)


def _source_hash(src: Path) -> str:
    with src.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def cleanup_cache(keep: Path | None = None) -> None:
    entries = []
    for folder in CACHE.iterdir():
        if folder.is_dir():
            size = sum(path.stat().st_size for path in folder.iterdir() if path.is_file())
            entries.append((folder.stat().st_mtime, folder, size))
    total = sum(size for _, _, size in entries)
    for _, folder, size in sorted(entries):
        if total <= MAX_CACHE_BYTES:
            break
        if folder != keep:
            shutil.rmtree(folder, ignore_errors=True)
            total -= size


def _source_audio(src: Path, key: str, cancel: threading.Event | None) -> tuple[np.memmap, Path, bool]:
    folder = CACHE / f"{CACHE_VERSION}-{key}"
    folder.mkdir(exist_ok=True)
    raw = folder / "audio.f32"
    cached = raw.exists() and raw.stat().st_size > 0 and raw.stat().st_size % 4 == 0
    if not cached:
        temporary = folder / "audio.partial"
        try:
            ffmpeg(["-i", str(src), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SR),
                    "-t", str(MAX_DURATION_SECONDS + 1), "-f", "f32le", str(temporary)], cancel)
            if not temporary.stat().st_size:
                raise ValueError("This file has no readable audio. Choose a file with an audio track.")
            if temporary.stat().st_size > MAX_DURATION_SECONDS * SR * 4:
                raise ValueError("Please use media shorter than 60 minutes.")
            temporary.replace(raw)
        finally:
            temporary.unlink(missing_ok=True)
    os.utime(folder, None)
    return np.memmap(raw, mode="r", dtype="<f4"), folder, cached


@torch.inference_mode()
def _cached_features(knn, audio: np.ndarray, lo: int, hi: int,
                     folder: Path) -> tuple[torch.Tensor, bool]:
    path = folder / f"{lo}-{hi}.pt"
    if path.exists():
        try:
            features = torch.load(path, map_location=DEVICE, weights_only=True)
            if isinstance(features, torch.Tensor) and features.ndim == 2 and features.shape[1] == 1024:
                return features, True
        except (OSError, RuntimeError, EOFError, pickle.UnpicklingError):
            logger.warning("Discarding an unreadable source feature cache: %s", path.name)
    features = _features(knn, audio[lo:hi])
    temporary = path.with_suffix(".tmp")
    try:
        torch.save(features.cpu(), temporary)
        temporary.replace(path)
    except OSError:
        logger.warning("Source features could not be cached; conversion can continue.")
    finally:
        temporary.unlink(missing_ok=True)
    return features, False


@torch.inference_mode()
def _convert_range(knn, index: MatchingIndex, audio: np.ndarray, a: int, b: int,
                   folder: Path) -> tuple[np.ndarray, bool]:
    lo, hi = max(0, a - CTX), min(len(audio), b + CTX)
    features, cached = _cached_features(knn, audio, lo, hi, folder)
    first, last = vocoder_window(knn, a - lo, b - a, len(features))
    output = knn.vocode(match_features(features[first:last], index)[None]).squeeze(0).cpu().numpy()
    offset = a - lo - first * HOP
    segment = output[offset:offset + b - a]
    if len(segment) < b - a:
        segment = np.pad(segment, (0, b - a - len(segment)))
    if not np.isfinite(segment).all():
        raise RuntimeError("The voice engine produced invalid audio. Please retry.")
    source = audio[a:b]
    rms_in = float(np.sqrt(np.mean(source ** 2)) + 1e-8)
    rms_out = float(np.sqrt(np.mean(segment ** 2)) + 1e-8)
    segment = segment * float(np.clip(rms_in / rms_out, 0.3, 3.0))
    peak = float(np.max(np.abs(segment)))
    if peak > 0.97:
        segment *= 0.97 / peak
    return segment, cached


def convert(src: Path, preview_wav: Path, full_wav: Path, voice_id: str, preview_seconds: float,
            progress: Progress, on_preview: Callable[[], None], *, quality: str = "studio",
            cache_key: str | None = None, cancel: threading.Event | None = None,
            on_stats: Callable[[dict], None] | None = None) -> dict:
    if voice_id not in VOICES or quality not in QUALITY_MODES:
        raise ValueError("Unknown voice or quality mode")
    if preview_seconds <= 0:
        raise ValueError("Preview duration must be positive")
    with _job_lock:
        check_cancel(cancel)
        progress(2, "Reading the audio (or reusing its cache)…")
        audio, folder, cached = _source_audio(src, cache_key or _source_hash(src), cancel)
        stats = {"duration": round(len(audio) / SR, 3), "processed_seconds": 0,
                 "source_cache_hit": cached, "feature_cache_hits": 0, "silent_seconds": 0,
                 "eta_seconds": None, "realtime_factor": None}
        try:
            if on_stats:
                on_stats(dict(stats))
            n = len(audio)
            first = min(n, max(HOP, int(preview_seconds * SR) // HOP * HOP))
            bounds = [0, first]
            while bounds[-1] < n:
                bounds.append(min(n, bounds[-1] + CHUNK))
            knn = None
            index = None
            conversion_seconds = 0.0
            with wave.open(str(full_wav), "wb") as writer:
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(SR)
                for i, (a, b) in enumerate(zip(bounds, bounds[1:])):
                    check_cancel(cancel)
                    # Preserve genuinely silent stretches instead of hallucinating speech.
                    silent = float(np.max(np.abs(audio[a:b]))) < 1e-5
                    if not silent and knn is None:
                        progress(5, "Loading the voice engine…")
                        knn = _model()
                        index = _index(voice_id, quality, progress, cancel)
                    check_cancel(cancel)
                    started = time.monotonic()
                    if silent:
                        segment = np.zeros(b - a, dtype=np.float32)
                        stats["silent_seconds"] += (b - a) / SR
                    else:
                        segment, hit = _convert_range(knn, index, audio, a, b, folder)
                        stats["feature_cache_hits"] += int(hit)
                    check_cancel(cancel)
                    writer.writeframesraw(pcm16(segment))
                    conversion_seconds += time.monotonic() - started
                    processed = b / SR
                    stats.update(processed_seconds=round(processed, 3),
                                 eta_seconds=round((n - b) / SR * conversion_seconds / processed, 1),
                                 realtime_factor=round(processed / max(conversion_seconds, 0.001), 2))
                    if on_stats:
                        on_stats(dict(stats))
                    progress(20 + int(b / n * 75), "Converting voice with cached features…" if cached else "Converting the voice…")
                    if i == 0:
                        write_wav(preview_wav, segment)
                        on_preview()
            return stats
        finally:
            audio._mmap.close()
            try:
                cleanup_cache()
            except OSError:
                logger.warning("Could not clean older source caches.")
