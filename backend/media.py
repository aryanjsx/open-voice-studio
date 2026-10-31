"""Bounded, cancellable FFmpeg operations shared by the API and voice engine."""

import subprocess
import threading
import time
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
SR = 16000


class ConversionCancelled(Exception):
    """Cooperative cancellation; never delete files underneath an active worker."""


def check_cancel(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise ConversionCancelled("Conversion cancelled")


def ffmpeg(args: list[str], cancel: threading.Event | None = None,
           *, capture: bool = False, timeout: float = 900) -> bytes:
    check_cancel(cancel)
    command = [FFMPEG, "-nostdin", "-y", "-hide_banner", "-loglevel", "error", *args]
    with subprocess.Popen(command, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.PIPE) as process:
        started = time.monotonic()
        try:
            while True:
                check_cancel(cancel)
                if time.monotonic() - started > timeout:
                    raise TimeoutError("Media processing timed out. Try a shorter file.")
                try:
                    stdout, stderr = process.communicate(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    continue
        except BaseException:
            process.kill()
            process.communicate()
            raise
        if process.returncode:
            detail = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail[-1000:] or "FFmpeg could not process this media file.")
        return stdout or b""


def decode_audio(path: Path, cancel: threading.Event | None = None) -> np.ndarray:
    raw = ffmpeg(["-i", str(path), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SR),
                  "-f", "f32le", "pipe:1"], cancel, capture=True)
    return np.frombuffer(raw, dtype=np.float32).copy()


def pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


def write_wav(path: Path, audio: np.ndarray) -> None:
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(SR)
        writer.writeframes(pcm16(audio))