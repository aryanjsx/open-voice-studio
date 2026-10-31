# Open Voice Studio

Open Voice Studio is a local voice-conversion app for turning uploaded video or audio into alternate synthetic voices while keeping the original media container and output workflow fast enough for everyday use.

It combines a Next.js frontend with a FastAPI backend powered by WavLM, kNN-VC, and HiFiGAN-style synthesis. The project is designed for local use on a personal machine and is not intended to be exposed publicly without authentication.

## Features

- Eight voice presets spanning Indian, American, British, and Australian styles.
- Upload support for video and audio formats including MP4, MOV, MKV, WebM, MP3, WAV, M4A, FLAC, OGG, AAC, and Opus.
- Original-container export for video, plus WAV/MP3 audio export.
- Comparison previews, queueing, job status tracking, cancellation, and persistent recent conversions.
- Reuse of cached source audio, converted output, and preview files to avoid unnecessary neural inference.
- Local-only job storage with queued job limits and recovery after restarts.

## Project structure

- backend/: FastAPI server, conversion pipeline, voice preparation, and tests
- frontend/: Next.js app for the studio UI
- BENCHMARKS.md: benchmarking notes and summary results

## Requirements

- Python 3.10+ recommended
- Node.js 20+ and npm
- FFmpeg installed and available on PATH
- A CUDA-capable GPU is optional; CPU inference is used when CUDA is unavailable

## Quick start

### 1) Backend setup

From the repository root:

```bash
cd backend
python -m venv .venv
# Windows
.\.venv\Scripts\Activate.ps1
# macOS/Linux
source .venv/bin/activate
pip install -r requirements.txt
```

The backend requires the Python packages listed in [backend/requirements.txt](backend/requirements.txt), including PyTorch and audio tooling.

Prepare the voice samples once:

```bash
python prepare_voices.py
```

Then start the API:

```bash
uvicorn main:app --host 127.0.0.1 --port 8001 --reload
```

### 2) Frontend setup

From the repository root:

```bash
cd frontend
npm install
npm run dev
```

The frontend runs by default on http://127.0.0.1:3000. If you need a different backend URL, set:

```bash
NEXT_PUBLIC_API_URL=http://127.0.0.1:8001
```

## Notes

- The backend warms models on startup and automatically falls back to CPU when CUDA is not available.
- Keep both services running in separate terminal sessions while working locally.
- This app is intended for personal/local use. Do not expose the API publicly without authentication and network controls.
- The project treats voice conversion as a local media workflow, not a translation system.

## Validation

- Frontend: `cd frontend && npm run lint`
- Backend tests: `cd backend && python -m unittest discover tests`
- Benchmark and performance notes: [BENCHMARKS.md](BENCHMARKS.md)
