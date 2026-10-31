# Performance and verification — 2026-10-30

## Environment and method

- AMD Ryzen 5 PRO 215, six physical cores / twelve logical processors, 14.6 GB RAM.
- CPU-only PyTorch runtime; integrated Radeon 740M is not a CUDA device.
- 16 kHz inference with 12 PyTorch threads; warmed model and cached target references.
- Five-second spoken reference clip, converted to the Indian male preset. The
  [benchmark](backend/benchmark.py) compares the installed upstream `knn.match()`
  with the new matcher, using the same model and feature vectors. Neural-stage
  results are medians of three runs. This is a local microbenchmark, not a
  production throughput or subjective speech-quality evaluation.

## Measured times

| Work | Seconds |
| --- | ---: |
| Legacy feature extraction + matching + vocoder | 1.1118 |
| New Studio feature extraction + matching + vocoder | 1.0745 |
| New Fast feature extraction + matching + vocoder | 1.0302 |
| New Studio with source features already cached | 0.7223 |
| Full pipeline, first source decode/extraction | 1.1923 |
| Full pipeline, same source features reused | 0.7286 |

The fresh neural-stage improvement is modest on this short clip; the larger gain
comes from reusing work. Source reuse reduced the full pipeline time by about 39%
(about 1.64× throughput). Format-only changes avoid inference entirely.

Live HTTP checks additionally measured:

- First five-second WAV conversion: 2.0 seconds of active job time, including setup.
- Seven subsequent different voices on that upload: about 0.8 seconds each.
- Re-export of completed conversion to MP3: 0.1 seconds, with a conversion-cache hit.
- Eighteen-second multi-chunk MP4 conversion and packaging: 6.8 seconds.

Do not extrapolate these timings to all files. Cold model loading, reference
synthesis, upload size, codec/container behavior, machine load, duration, and
quality settings affect latency. The UI displays measured progress, not an instant
conversion promise. Rate estimates exclude reference preparation and packaging.

## Correctness checks

- Removing unused WavLM layers left layer-six features exactly equal on the tested
  fixture. Encoder parameters fell from 315,453,120 to 88,711,440: ~865 MiB fewer
  FP32 parameter bytes retained after initialization, not a measured total-RSS saving.
- New full-reference matching produced zero mean absolute waveform difference from
  the legacy matcher on the benchmark speech features. This does not claim every
  complete conversion is bit-identical: decoding precision and chunk sizes changed.
- All eight voice sample endpoints returned exactly five seconds of WAV audio.
- All eight presets produced distinct, valid converted WAV files and previews.
- Input smoke tests passed for MP4, MOV, M4V, MKV, WebM, MP3, WAV, M4A, FLAC, OGG,
  AAC, and Opus. These were generated small fixtures, not every possible codec profile.
- Full video exports retained their encoded video streams (SHA-256 equality).
- WAV and MP3 exports, upload reuse, feature-cache hits, output-cache hits, queued
  cancellation, active-job deletion protection, request validation, CORS, and the
  frontend HTTP response were checked against the running server.
- All 21 generated test job records survived a real server restart; an existing
  completed export remained downloadable. Only these test jobs were deleted afterward.
- Eleven passing backend regression checks cover cosine neighbors, bounded indices, silence,
  cancellation, memory-map release, cache eviction, output reuse, and job deletion.
- Frontend ESLint and TypeScript checks passed. Browser interaction automation and
  subjective listening evaluations were not performed.

## Additional efficiency pass — existing features unchanged

This second pass retains the UI, eight voices, Fast/Studio reference pools, trained
weights, FP32 inference, full-context WavLM extraction, and output formats. No new
dependencies, quantization, or JIT compilation were introduced.

### Measured improvements

| Work | Before (seconds) | After (seconds) | Time reduction |
| --- | ---: | ---: | ---: |
| Model initialization from cached checkpoints | 4.1674 | 1.5567 | 62.6% |
| 18-second multi-chunk pipeline, first source | 5.6603 | 5.2889 | 6.6% |
| 18-second multi-chunk pipeline, cached source features | 3.8382 | 3.2825 | 14.5% |

- Initialization numbers are three-run medians in the same process, alternating loader
  order, including garbage collection and excluding subsequent inference. They compare
  constructing the full encoder then trimming it against constructing only six layers
  and attaching the original checkpoint tensors. This is not a network-download or
  whole-server startup benchmark; a separate first engine load measured 2.3026 seconds.
- Pipeline numbers come from [backend/benchmark_efficiency.py](backend/benchmark_efficiency.py):
  three alternating runs per path, repeated cached synthetic speech, Indian male/Studio,
  the same warmed model and reference index, and isolated temporary source caches. The
  baseline synthesizes the full context; the optimized path retains only the vocoder's
  required context. Both share the new loader and fixed positional-convolution weights,
  so these numbers isolate windowing rather than combining every optimization's benefit.
- Pipeline timing includes decoding, extraction/cache I/O, matching, synthesis, and WAV
  writes. It excludes upload, API metadata, video preview, and final-container packaging.
- Identical MP4, MP3, and WebM re-exports invoked **no FFmpeg or neural conversion** in
  API integration checks. Files are linked/copied from completed compatible jobs. The
  API rounded these short active-job durations to 0.0 seconds; they are not zero-cost.
- Switching voices reuses the already-encoded preview video stream with the new audio.
  Large-upload hashing/copying no longer blocks the request event loop. Per-chunk stats
  and progress use a single durable metadata write rather than two.

These are local CPU measurements on specific fixtures, not a universal speed guarantee.
The earlier five-second benchmarks above used a different workload and are retained as
historical results, not a directly comparable baseline for this pass.

### Feature-parity checks

- The compact loader and one-time positional weight normalization produced **exactly
  equal layer-six features** to the previous loader on the checked speech fixture.
- Full versus bounded-context synthesis was checked for all eight voices in both modes,
  including leading/trailing and non-hop-aligned retained intervals. The largest absolute
  waveform difference in that sweep was 0.00000411. Separate middle-chunk checks passed.
- Very short/non-aligned inputs (1, 399, 401, 1599, 1601, and 79999 samples) retained enough
  synthesized samples. The complete eighteen-second comparison had the same sample count
  and a maximum PCM16 difference of one count; mean difference was about 0.00117 counts.
  These numerical checks do not substitute for subjective listening evaluation.
- Twenty lightweight backend regressions passed, covering existing behavior plus dependency
  windows, unchanged checkpoint tensors, unknown-graph fallback, exact export/preview reuse,
  durable progress, upload bytes/hash/limits, and cooperative upload cancellation without
  unhandled errors on Python 3.14.
- An isolated FastAPI integration run checked MP4/WebM video-stream hashes, byte-identical
  cached MP4/MP3 exports, cross-voice preview-video reuse with different audio, WAV sample
  counts, feature-cache hits, all eight five-second samples, CORS, cancellation/deletion
  protection, metadata restoration, and cache cleanup after deleting the final related job.
  All nine temporary jobs were removed; the existing user job metadata was unchanged.