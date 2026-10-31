"""Compare the previous full-context synthesis path with bounded-context synthesis.

Uses cached synthetic speech only, temp source caches, the same FP32 model, and
the same quality mode. Does not read, edit, or delete user jobs.
"""

import argparse
import json
import statistics
import tempfile
import time
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch

import pipeline
from media import decode_audio, write_wav
from voices import SAMPLES


def read_pcm(path: Path) -> np.ndarray:
    with wave.open(str(path)) as audio:
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--seconds", type=int, default=18)
    args = parser.parse_args()
    if not 1 <= args.runs <= 10 or not 1 <= args.seconds <= 60:
        parser.error("Use 1–10 runs and 1–60 seconds.")
    started = time.perf_counter()
    knn = pipeline._model()
    initialization = time.perf_counter() - started
    pipeline._index("male", "studio", lambda *_: None, None)
    sample = decode_audio(SAMPLES / "american_male.wav")
    source_audio = np.tile(sample, (args.seconds + 4) // 5)[:args.seconds * pipeline.SR]
    timings = {name: {"first": [], "cached": []} for name in ("previous", "optimized")}
    outputs = {}
    window = pipeline.vocoder_window
    with tempfile.TemporaryDirectory(prefix="voice-efficiency-") as temporary:
        root = Path(temporary)
        source = root / "source.wav"
        write_wav(source, source_audio)
        # Warm convolution kernels without counting initialization in conversion.
        with torch.inference_mode():
            features = pipeline._features(knn, sample)
            knn.vocode(pipeline.match_features(features, pipeline._index("male", "studio", lambda *_: None, None))[None])
        for iteration in range(args.runs):
            order = ("previous", "optimized") if iteration % 2 == 0 else ("optimized", "previous")
            for name in order:
                cache = root / f"{name}-{iteration}"
                cache.mkdir()
                choose = window if name == "optimized" else lambda _m, _s, _n, frames: (0, frames)
                with patch.object(pipeline, "CACHE", cache), patch.object(pipeline, "vocoder_window", choose):
                    for reuse in ("first", "cached"):
                        started = time.perf_counter()
                        stats = pipeline.convert(source, root / "preview.wav", root / "full.wav", "male", 5,
                                                 lambda *_: None, lambda: None, quality="studio")
                        timings[name][reuse].append(time.perf_counter() - started)
                        if reuse == "cached":
                            assert stats["feature_cache_hits"] > 0
                    outputs[name] = read_pcm(root / "full.wav")
    delta = np.abs(outputs["previous"] - outputs["optimized"])
    assert len(outputs["previous"]) == args.seconds * pipeline.SR
    assert delta.max() <= 2, "Unexpected PCM waveform difference"
    result = {"audio_seconds": args.seconds, "runs": args.runs, "device": pipeline.DEVICE,
              "initialization_seconds": round(initialization, 4),
              "median_seconds": {name: {kind: round(statistics.median(values), 4) for kind, values in groups.items()}
                                 for name, groups in timings.items()},
              "max_pcm16_delta": float(delta.max()), "mean_pcm16_delta": float(delta.mean())}
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()