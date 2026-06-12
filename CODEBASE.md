# Misc API

Permanent miscellaneous API service for `api.girke.dev`. Separate from the LLM Wiki API.

## Endpoints

- `GET /` — service name/version.
- `GET /health` — lightweight health check, no auth.
- `GET /version` — deployed app version, no auth.
- `GET /api/v1/transcription/jobs` — transcription job list placeholder, requires `X-API-Key`.
- `POST /api/v1/transcription/transcribe` — transcribe uploaded `file` via whisper sidecar, requires `X-API-Key`.
- `GET /api/v1/feeds/` — feed list placeholder, requires `X-API-Key`.
