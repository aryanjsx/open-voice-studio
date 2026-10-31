"""Prepare selected voices once so later conversions need no TTS network calls."""

import argparse
import asyncio
import time

import pipeline
from voices import VOICES, prepare_samples


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples-only", action="store_true")
    parser.add_argument("--voices", nargs="+", choices=list(VOICES), default=list(VOICES))
    args = parser.parse_args()
    asyncio.run(prepare_samples())
    if args.samples_only:
        return
    pipeline.warmup()
    failures = []
    for voice_id in args.voices:
        started = time.monotonic()
        try:
            with pipeline._job_lock:
                features = pipeline._matching_set(voice_id, lambda _p, text: print(text, flush=True))
            print(f"Ready: {VOICES[voice_id].name}, {len(features)} frames, {time.monotonic() - started:.1f}s", flush=True)
        except Exception as exc:
            failures.append(voice_id)
            print(f"Not ready: {voice_id}: {exc}", flush=True)
    if failures:
        raise SystemExit(f"Retry preparation for: {', '.join(failures)}")


if __name__ == "__main__":
    main()