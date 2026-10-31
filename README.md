# Voice Studio

Local video/audio voice conversion with eight synthetic voice presets, five-second
reference samples, and early previews of converted media. Uses Next.js/React and a
FastAPI + WavLM/kNN-VC/HiFiGAN backend. This is voice conversion, not translation.

## Features

- Eight distinct Indian, American, British, and Australian voice presets; searchable
  cards, gender/accent filters, favorites, and exclusive five-second sample playback.
- Video inputs: MP4, MOV, M4V, MKV, WebM. Audio inputs: MP3, WAV, M4A, FLAC, OGG, AAC, Opus.
- Original-container video export without re-encoding video, or WAV/MP3 audio exports.
- Five-second original/converted comparison, queue position, progress, processing-rate
  and remaining-time estimates, cancellation, and persisted recent conversions.
- Reuse an upload with another voice. Exporting the same voice/quality in another format
  reuses converted audio and avoids repeating neural inference. Repeating an identical
  export reuses its encoded output and preview, without invoking the model or FFmpeg.
- 512 MB/file, 60 minutes/media, and eight queued/active jobs maximum. Local-only API;
  do not expose this unauthenticated personal workspace to the public internet.

## Runtime

- Backend: use the existing backend virtual environment and install
  [backend/requirements.txt](backend/requirements.txt) if setting up a new machine. Run Uvicorn with `main:app`
  from the backend directory, bound to `127.0.0.1:8001`.
- Frontend: install the locked npm dependencies in `frontend`, then run its `dev`
  script on `127.0.0.1:3000`. `NEXT_PUBLIC_API_URL` overrides the API base URL.
- Keep both servers in chat-managed background terminals, not VS Code task terminals.
- The model warms in the background on API startup. CUDA is selected only when the
  installed PyTorch build and hardware actually support it; otherwise CPU is used.
- [backend/prepare_voices.py](backend/prepare_voices.py) prepares all samples/references ahead of time; `--samples-only`
  and `--voices` limit preparation. Initial downloads/reference synthesis need internet.
  Once cached, those references and samples are served locally. Samples demonstrate
  the target reference voice, not a guarantee of conversion quality on arbitrary audio.

## Performance design

- Only WavLM layers 1–6 are used by kNN-VC. The optimized loader constructs those six
  layers directly and attaches the original checkpoint tensors, using memory mapping
  when supported. It avoids constructing layers 7–24, while retaining exactly the same
  tested features and 88,711,440 encoder parameters. A compatible full-loader fallback
  remains available. Fixed positional weight normalization is materialized just once.
- Normalize and cache search vectors once; use bounded matrix multiplication and exact
  cosine top-4 matching. Keep original unnormalized vectors for the trained vocoder.
- Studio searches the full reference set. Fast caps it at 6,000 evenly distributed
  frames: it trades some reference coverage for cheaper search, not a different model.
- Source audio is decoded once directly to a memory-mapped cache. WavLM features are
  cached by source content and segment bounds, so switching voices reuses extraction.
- WavLM still sees the same complete chunk context. Matching and HiFiGAN synthesis
  process only frames that can affect retained audio, with context derived from the
  vocoder's convolution graph and a conservative guard. Unknown graphs use full context.
  Models, FP32 precision, voice pools, timing, and quality settings are unchanged.
- Stream converted PCM to disk instead of accumulating a whole output in RAM. Genuine
  silent chunks bypass inference. Reference/index memory uses small LRU caches.
- A bounded single neural worker avoids oversubscribing CPU/RAM. Preview video uses
  a lightweight encode cached per source; changing voices remuxes that video with the
  new audio instead of encoding the video again. Full exports copy original video streams.
- Upload copying and SHA-256 hashing run together in an I/O worker so large uploads do
  not block the API event loop. Chunk metrics and progress share one atomic metadata write.
- `VOICE_THREADS` overrides the CPU thread cap (default: logical cores, maximum 12).
  `VOICE_CACHE_MB` controls the derived source-cache budget (default: 2048 MB).

Speed depends on hardware, duration, reference preparation, and model inference.
The displayed pipeline rate excludes upload, startup, reference preparation, and
packaging; it is not a promised end-to-end rate. Integrated AMD graphics are not CUDA.
Speech-only input is recommended: this pipeline does not separate background music.

## Storage and recovery

Each UUID job directory contains its source, previews, converted audio/export, and
atomic JSON metadata. Completed jobs survive restart; interrupted jobs become failed
with an actionable retry message. Cancelled jobs keep their source for reuse. Delete
is blocked while a job is active. Deleting the final job for a source also removes its
derived audio/feature/video-preview cache. Reference voices remain cached. Exports remain until deleted.

## Lightweight verification

- Frontend: npm `lint`, local TypeScript `--noEmit --incremental false`.
- Backend: standard-library unittest discovery for [backend/tests/test_pipeline.py](backend/tests/test_pipeline.py)
  and [backend/tests/test_optimizations.py](backend/tests/test_optimizations.py) (no network/trained-model load).
- [backend/benchmark.py](backend/benchmark.py): three-run median comparison against the installed upstream
  matcher on the same five-second speech sample, plus cold-source/warm-source timings.
  Prepare samples/references first. Avoid benchmarking while other conversions run.
- [backend/benchmark_efficiency.py](backend/benchmark_efficiency.py): three-run median, eighteen-second
  multi-chunk comparison of full-context versus bounded-context synthesis, including
  first-source and reused-feature pipelines. Uses temporary caches and no user media.
- See [BENCHMARKS.md](BENCHMARKS.md) for measured results and verification scope.