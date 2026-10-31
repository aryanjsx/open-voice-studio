"""Compare warmed neural stages on the same five-second speech sample.

Run after prepare_voices.py. Results exclude reference downloads and upload time.
The legacy matcher is the installed upstream kNN-VC implementation, not a mock.
"""

import json
import statistics
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import torch

import pipeline
from media import decode_audio
from voices import SAMPLES


def main() -> None:
    sample = SAMPLES / "american_male.wav"
    if not sample.exists():
        raise SystemExit("Prepare voice samples first.")
    knn = pipeline._model()
    audio = decode_audio(sample)
    reference = pipeline._matching_set("male", lambda *_: None)
    studio = pipeline._index("male", "studio", lambda *_: None, None)
    fast = pipeline._index("male", "fast", lambda *_: None, None)
    results = {}
    with torch.inference_mode():
        features = pipeline._features(knn, audio)
        legacy = knn.match(features, reference, topk=4, tgt_loudness_db=None)
        exact = knn.vocode(pipeline.match_features(features, studio)[None]).squeeze(0).cpu()
        results["studio_waveform_mean_absolute_delta"] = (legacy - exact).abs().mean().item()
        timings = {name: [] for name in ("legacy", "studio", "fast", "cached_features")}
        for _ in range(3):
            for name in timings:
                started = time.perf_counter()
                query = features if name == "cached_features" else pipeline._features(knn, audio)
                if name == "legacy":
                    knn.match(query, reference, topk=4, tgt_loudness_db=None)
                else:
                    matched = pipeline.match_features(query, fast if name == "fast" else studio)
                    knn.vocode(matched[None]).cpu()
                timings[name].append(time.perf_counter() - started)
        results["median_neural_seconds"] = {name: round(statistics.median(times), 4) for name, times in timings.items()}
    with tempfile.TemporaryDirectory(prefix="voice-benchmark-") as temporary:
        folder = Path(temporary)
        cache = folder / "cache"
        cache.mkdir()
        with patch.object(pipeline, "CACHE", cache):
            for name in ("first_conversion", "reused_source"):
                started = time.perf_counter()
                stats = pipeline.convert(sample, folder / "preview.wav", folder / "full.wav", "male", 5,
                                         lambda *_: None, lambda: None, quality="studio")
                results[name] = {"seconds": round(time.perf_counter() - started, 4),
                                 "source_cache_hit": stats["source_cache_hit"],
                                 "feature_cache_hits": stats["feature_cache_hits"]}
    results.update(audio_seconds=len(audio) / pipeline.SR, device=pipeline.DEVICE,
                   threads=pipeline.THREADS, encoder_parameters=sum(p.numel() for p in knn.wavlm.parameters()))
    print(json.dumps(results, indent=2), flush=True)


if __name__ == "__main__":
    main()