"""Local voice studio API: bounded jobs, persisted history, and reusable uploads."""

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import pipeline
from media import ConversionCancelled, check_cancel, ffmpeg
from voices import VOICES, catalog, ensure_sample, prepare_samples

logger = logging.getLogger(__name__)
STORAGE = Path(__file__).parent / "storage"
STORAGE.mkdir(exist_ok=True)
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus"}
ALLOWED_EXT = VIDEO_EXT | AUDIO_EXT
PREVIEW_SECONDS = 5
MAX_UPLOAD_BYTES = 512 * 1024 ** 2
MAX_PENDING_JOBS = 8
TERMINAL_STATES = {"done", "error", "cancelled"}
ID_RE = re.compile(r"^[0-9a-f]{32}$")
JOBS: dict[str, dict] = {}
_lock = threading.RLock()
_events: dict[str, threading.Event] = {}
_futures: dict[str, Future] = {}
_executor: ThreadPoolExecutor | None = None


def _save(job: dict) -> None:
    folder = STORAGE / job["id"]
    temporary = folder / "job.tmp"
    temporary.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    temporary.replace(folder / "job.json")


def _update(job_id: str, *, persist: bool = True, **values) -> None:
    with _lock:
        job = JOBS[job_id]
        if job["status"] == "cancelling" and values.get("status") in {
            "processing_preview", "processing_full", "finalizing", "done"
        }:
            check_cancel(_events.get(job_id))
        job.update(values)
        if persist:
            _save(job)


def _restore_jobs() -> None:
    for path in STORAGE.glob("*/job.json"):
        if not ID_RE.fullmatch(path.parent.name):
            continue
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if job["id"] != path.parent.name or Path(job["source"]).name != job["source"]:
                continue
            if not (path.parent / job["source"]).exists():
                continue
            if job["status"] not in TERMINAL_STATES:
                job.update(status="error", error="Server restarted. Reuse this upload to try again.",
                           detail="Interrupted by a server restart", finished_at=time.time())
                _save(job)
            JOBS[job["id"]] = job
        except (OSError, ValueError, KeyError, TypeError):
            logger.warning("Skipping unreadable job metadata: %s", path.parent.name)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _executor
    _restore_jobs()
    _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-conversion")
    warmup = asyncio.create_task(asyncio.to_thread(pipeline.warmup))
    samples = asyncio.create_task(prepare_samples())
    yield
    with _lock:
        for event in _events.values():
            event.set()
    samples.cancel()
    await asyncio.gather(samples, warmup, return_exceptions=True)
    _executor.shutdown(wait=True, cancel_futures=True)


app = FastAPI(title="Voice Studio API", lifespan=lifespan)
app.add_middleware(CORSMiddleware,
                   allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["Content-Disposition"])


def get_job(job_id: str) -> dict:
    with _lock:
        if not ID_RE.fullmatch(job_id) or job_id not in JOBS:
            raise HTTPException(404, "Job not found")
        return dict(JOBS[job_id])


def public_job(job_id: str) -> dict:
    job = get_job(job_id)
    now = job.get("finished_at") or time.time()
    job["elapsed_seconds"] = round(max(0, now - (job.get("started_at") or now)), 1)
    job["queue_position"] = 0
    if job["status"] == "queued":
        with _lock:
            waiting = sorted((j for j in JOBS.values() if j["status"] == "queued"),
                             key=lambda j: j["created_at"])
            job["queue_position"] = next((i + 1 for i, j in enumerate(waiting) if j["id"] == job_id), 0)
    for key in ("source", "source_hash", "output"):
        job.pop(key, None)
    return job


def _link_or_copy(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def _store_upload(stream, destination: Path, cancel: threading.Event) -> tuple[str, int]:
    """Hash and copy in one I/O worker, not on FastAPI's request event loop."""
    size = 0
    hasher = hashlib.sha256()
    with destination.open("wb") as writer:
        while True:
            check_cancel(cancel)
            chunk = stream.read(4 * 1024 ** 2)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File too large. The limit is 512 MB.")
            hasher.update(chunk)
            writer.write(chunk)
    if not size:
        raise HTTPException(400, "The uploaded file is empty.")
    return hasher.hexdigest(), size


async def store_upload(upload: UploadFile, destination: Path) -> tuple[str, int]:
    cancel = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(_store_upload, upload.file, destination, cancel))
    try:
        # wait() does not cancel the underlying task when its caller is cancelled.
        # Unlike shield(), it also avoids spurious exception reports on Python 3.14
        # when this cooperative worker exits during request cancellation.
        await asyncio.wait({task})
        return task.result()
    except asyncio.CancelledError:
        # A thread is not stopped by cancelling its awaiter. Join it before the
        # request's cleanup closes the upload or removes its output directory.
        cancel.set()
        await asyncio.gather(task, return_exceptions=True)
        raise


def reuse_converted_audio(job: dict, folder: Path) -> dict | None:
    """Reuse audio and, when compatible, the already-encoded preview/export."""
    reused = None
    with _lock:
        candidates = [candidate for candidate in JOBS.values()
                      if candidate["status"] == "done" and candidate["id"] != job["id"]
                      and all(candidate[key] == job[key] for key in ("source_hash", "voice", "quality"))]
        for candidate in candidates:
            previous = STORAGE / candidate["id"]
            if not all((previous / name).is_file() for name in ("dub_full.wav", "dub_preview.wav")):
                continue
            if reused is None:
                for name in ("dub_full.wav", "dub_preview.wav"):
                    _link_or_copy(previous / name, folder / name)
                reused = {"duration": candidate.get("duration"),
                          "processed_seconds": candidate.get("duration"), "source_cache_hit": True,
                          "conversion_cache_hit": True, "feature_cache_hits": 0,
                          "realtime_factor": None, "eta_seconds": 0}
            if job.get("output_kind") == "video" and not (folder / "preview.mp4").exists():
                preview = previous / "preview.mp4"
                if preview.is_file():
                    _link_or_copy(preview, folder / "preview.mp4")
                    reused["preview_cache_hit"] = True
            if (not reused.get("export_cache_hit") and candidate.get("output")
                    and candidate.get("output_kind") == job.get("output_kind")
                    and candidate.get("output_ext") == job.get("output_ext")):
                output = previous / candidate["output"]
                # WAV already uses the linked dub_full.wav; it needs no re-encoding.
                if output.is_file() and job.get("output_ext") != ".wav":
                    _link_or_copy(output, folder / f"output{job['output_ext']}")
                    reused["export_cache_hit"] = True
    return reused


def build_preview(job: dict, source: Path, folder: Path, cancel: threading.Event) -> bool:
    """Encode preview video once per source; changing voices only remuxes audio."""
    output = folder / "preview.mp4"
    if output.is_file():
        return True
    cache = pipeline.CACHE / f"{pipeline.CACHE_VERSION}-{job['source_hash']}"
    video = cache / "preview-video-v1.mp4"
    if video.is_file():
        try:
            ffmpeg(["-i", str(video), "-i", str(folder / "dub_preview.wav"),
                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
                    str(output)], cancel)
            os.utime(cache, None)
            return True
        except RuntimeError:
            logger.warning("Cached video preview is unreadable; recreating it.")
            video.unlink(missing_ok=True)
    ffmpeg([
        "-t", str(PREVIEW_SECONDS), "-i", str(source), "-i", str(folder / "dub_preview.wav"),
        "-map", "0:v:0", "-map", "1:a:0", "-vf", "scale='min(960,iw)':-2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p",
        "-threads", "2", "-c:a", "aac", "-b:a", "128k", "-shortest",
        "-movflags", "+faststart", str(output),
    ], cancel)
    check_cancel(cancel)
    try:
        cache.mkdir(parents=True, exist_ok=True)
        # The cached MP4's audio is never reused across voices: map only its video.
        _link_or_copy(output, video)
        os.utime(cache, None)
    except OSError:
        logger.warning("Preview is ready but could not be cached for later reuse.")
    return False


def process(job_id: str) -> None:
    job = get_job(job_id)
    folder = STORAGE / job_id
    source = folder / job["source"]
    full = folder / "dub_full.wav"
    cancel = _events[job_id]
    reused = None

    def progress(percent: int, detail: str) -> None:
        check_cancel(cancel)
        with _lock:
            _update(job_id, progress=max(JOBS[job_id].get("progress", 0), min(percent, 99)), detail=detail)

    def on_preview() -> None:
        check_cancel(cancel)
        cached_preview = False
        if job["output_kind"] == "video":
            cached_preview = build_preview(job, source, folder, cancel)
        _update(job_id, preview=True, status="processing_full", preview_cache_hit=cached_preview)

    try:
        check_cancel(cancel)
        _update(job_id, status="processing_preview", started_at=time.time(), detail="Preparing your audio…")
        reused = reuse_converted_audio(job, folder)
        if reused is not None:
            _update(job_id, **reused)
            progress(95, "Reusing the converted audio; no neural processing needed…")
            on_preview()
        else:
            pipeline.convert(source, folder / "dub_preview.wav", full, job["voice"], PREVIEW_SECONDS,
                             progress, on_preview, quality=job["quality"], cache_key=job["source_hash"],
                             # The immediately following progress event persists both
                             # metrics and progress in one atomic metadata write.
                             cancel=cancel, on_stats=lambda stats: _update(job_id, persist=False, **stats))
        check_cancel(cancel)
        _update(job_id, status="finalizing", progress=98, detail="Packaging your download…", eta_seconds=None)
        extension = job["output_ext"]
        output = folder / f"output{extension}"
        if reused is not None and reused.get("export_cache_hit"):
            pass  # The identical completed export is already linked into this job.
        elif job["output_kind"] == "video":
            codec = ["-c:a", "libopus", "-b:a", "192k"] if extension == ".webm" else ["-c:a", "aac", "-b:a", "256k"]
            # Do not re-encode video: preserve its original frames and avoid that cost.
            ffmpeg(["-i", str(source), "-i", str(full), "-map", "0:v?", "-map", "1:a:0",
                    "-map_metadata", "0", "-c:v", "copy", *codec, "-ar", "48000", "-ac", "2",
                    *(["-movflags", "+faststart"] if extension in {".mp4", ".mov", ".m4v"} else []),
                    str(output)], cancel)
        elif extension == ".mp3":
            ffmpeg(["-i", str(full), "-c:a", "libmp3lame", "-b:a", "192k", str(output)], cancel)
        else:
            output = full
        check_cancel(cancel)
        _update(job_id, output=output.name, progress=100, status="done", finished_at=time.time(),
                detail="Your conversion is ready.", eta_seconds=0)
    except ConversionCancelled:
        _update(job_id, status="cancelled", detail="Conversion stopped. Your upload can be reused.",
                finished_at=time.time(), eta_seconds=None)
    except Exception as exc:
        logger.exception("Conversion failed for %s", job_id)
        _update(job_id, status="error", error=str(exc)[-500:], finished_at=time.time(), eta_seconds=None)
    finally:
        if reused is not None:
            # Re-exporting bypasses pipeline.convert(), including its cache cleanup.
            try:
                pipeline.cleanup_cache()
            except OSError:
                logger.warning("Could not clean older source caches after re-export.")


@app.get("/api/health")
def health():
    return {"status": "ok", "engine": pipeline.engine_info(), "preview_seconds": PREVIEW_SECONDS,
            "max_upload_bytes": MAX_UPLOAD_BYTES, "max_duration_seconds": pipeline.MAX_DURATION_SECONDS,
            "formats": sorted(ALLOWED_EXT), "quality_modes": pipeline.QUALITY_MODES}


@app.get("/api/voices")
def voices():
    return catalog()


@app.get("/api/voices/{voice_id}/sample")
async def voice_sample(voice_id: str):
    if voice_id not in VOICES:
        raise HTTPException(404, "Voice not found")
    try:
        path = await ensure_sample(voice_id)
    except Exception as exc:
        raise HTTPException(503, str(exc)) from exc
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/jobs")
def recent_jobs():
    with _lock:
        ids = sorted(JOBS, key=lambda key: JOBS[key]["created_at"], reverse=True)[:30]
        return [public_job(job_id) for job_id in ids]


@app.post("/api/jobs")
async def create_job(file: UploadFile | None = File(None), voice: str = Form("male"),
                     quality: str = Form("studio"), output_format: str = Form("original"),
                     source_job_id: str | None = Form(None)):
    if voice not in VOICES:
        raise HTTPException(400, "Unknown voice")
    if quality not in pipeline.QUALITY_MODES or output_format not in {"original", "wav", "mp3"}:
        raise HTTPException(400, "Unknown quality mode or output format")
    if (file is None) == (source_job_id is None):
        raise HTTPException(400, "Choose either a file or a saved upload to reuse.")
    if _executor is None:
        raise HTTPException(503, "The conversion worker is starting. Please retry.")
    if file is not None and file.size is not None and file.size > MAX_UPLOAD_BYTES:
        await file.close()
        raise HTTPException(413, "File too large. The limit is 512 MB.")
    prior = get_job(source_job_id) if source_job_id is not None else None
    filename = prior["filename"] if prior else file.filename or "upload"
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXT:
        raise HTTPException(400, "Unsupported format. Use a supported video or audio file.")
    with _lock:
        if sum(j["status"] not in TERMINAL_STATES for j in JOBS.values()) >= MAX_PENDING_JOBS:
            raise HTTPException(429, "The queue is full. Wait for a conversion to finish.")
    job_id = uuid.uuid4().hex
    folder = STORAGE / job_id
    folder.mkdir()
    source = folder / f"source{extension}"
    try:
        if prior:
            original = STORAGE / prior["id"] / prior["source"]
            await asyncio.to_thread(_link_or_copy, original, source)
            digest = prior["source_hash"]
            size = prior["size_bytes"]
        else:
            digest, size = await store_upload(file, source)
        source_kind = "video" if extension in VIDEO_EXT else "audio"
        output_kind = "video" if source_kind == "video" and output_format == "original" else "audio"
        output_ext = extension if output_kind == "video" else ".mp3" if output_format == "mp3" else ".wav"
        job = {
            "id": job_id, "status": "queued", "voice": voice, "quality": quality,
            "output_format": output_format, "output_kind": output_kind, "output_ext": output_ext,
            "source_kind": source_kind, "source": source.name, "source_hash": digest,
            "filename": Path(filename).name, "name": Path(filename).stem, "size_bytes": size,
            "source_reused": prior is not None, "created_at": time.time(), "progress": 0,
            "preview": False, "detail": "Waiting for the conversion worker…", "error": None,
        }
        with _lock:
            if sum(j["status"] not in TERMINAL_STATES for j in JOBS.values()) >= MAX_PENDING_JOBS:
                raise HTTPException(429, "The queue is full. Please retry shortly.")
            JOBS[job_id] = job
            _events[job_id] = threading.Event()
            _save(job)
            _futures[job_id] = _executor.submit(process, job_id)
        return {"id": job_id}
    except BaseException:
        with _lock:
            JOBS.pop(job_id, None)
            _events.pop(job_id, None)
        shutil.rmtree(folder, ignore_errors=True)
        raise
    finally:
        if file is not None:
            await file.close()


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    return public_job(job_id)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    with _lock:
        job = get_job(job_id)
        if job["status"] in TERMINAL_STATES:
            return public_job(job_id)
        _events[job_id].set()
        future = _futures.get(job_id)
        if future and future.cancel():
            _update(job_id, status="cancelled", detail="Removed from the queue.", finished_at=time.time())
        else:
            _update(job_id, status="cancelling", detail="Stopping after the current processing step…")
        return public_job(job_id)


@app.get("/api/jobs/{job_id}/source")
def original_media(job_id: str):
    job = get_job(job_id)
    path = STORAGE / job_id / job["source"]
    return FileResponse(path, media_type=mimetypes.guess_type(path)[0] or "application/octet-stream")


@app.get("/api/jobs/{job_id}/preview")
def preview(job_id: str):
    job = get_job(job_id)
    name = "preview.mp4" if job["output_kind"] == "video" else "dub_preview.wav"
    path = STORAGE / job_id / name
    if not job["preview"] or not path.exists():
        raise HTTPException(404, "Preview not ready")
    return FileResponse(path, media_type="video/mp4" if job["output_kind"] == "video" else "audio/wav")


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str):
    job = get_job(job_id)
    if job["status"] != "done":
        raise HTTPException(409, "Not ready")
    return FileResponse(STORAGE / job_id / job["output"],
                        filename=f"{job['name']}_{VOICES[job['voice']].name}{job['output_ext']}")


@app.get("/api/jobs/{job_id}/audio")
def download_audio(job_id: str):
    job = get_job(job_id)
    if job["status"] != "done":
        raise HTTPException(409, "Not ready")
    return FileResponse(STORAGE / job_id / "dub_full.wav", media_type="audio/wav",
                        filename=f"{job['name']}_{VOICES[job['voice']].name}.wav")


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    with _lock:
        job = get_job(job_id)
        if job["status"] not in TERMINAL_STATES:
            raise HTTPException(409, "Cancel the active conversion before deleting it.")
        shutil.rmtree(STORAGE / job_id)
        JOBS.pop(job_id, None)
        _events.pop(job_id, None)
        _futures.pop(job_id, None)
        # A cache contains derived source audio: remove it with the last related job.
        digest = job["source_hash"]
        if re.fullmatch(r"[a-f0-9]{64}", digest) and not any(j["source_hash"] == digest for j in JOBS.values()):
            shutil.rmtree(pipeline.CACHE / f"{pipeline.CACHE_VERSION}-{digest}", ignore_errors=True)
    return {"ok": True}
