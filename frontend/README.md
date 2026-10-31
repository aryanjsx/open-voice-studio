# Frontend README

This directory contains the Next.js interface for Open Voice Studio. It provides the upload flow, voice selection, conversion job queue, previews, and recent conversion history.

## Local development

From this directory:

```bash
npm install
npm run dev
```

Then open http://127.0.0.1:3000.

## Environment variables

```bash
NEXT_PUBLIC_API_URL=http://127.0.0.1:8001
```

Set this value if the backend is not running on the default local URL.

## App structure

- src/app/: main app shell and page entry
- src/components/studio/: UI panels and studio workflows
- src/hooks/: data fetching and state management
- src/lib/: API client and shared types

## Related

- [../README.md](../README.md): project overview and backend setup
- [../backend/requirements.txt](../backend/requirements.txt): backend dependencies
