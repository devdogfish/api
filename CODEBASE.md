# API

Permanent Girke API service for `api.girke.dev`. Separate from the LLM Wiki API.

## Endpoints

- `GET /` — service name/version.
- `GET /health` — lightweight health check, no auth.
- `GET /version` — deployed app version, no auth.
- `POST /api/v1/oona/contact` — public Oona Kokopelli Carrd contact form proxy; sends contact email through Sender and optionally subscribes to the configured Sender group. CORS allows `https://gallery.oonakokopelli.com`.
- `POST /api/v1/transcription/transcribe` — sync transcription for short media, requires `Authorization: Bearer girke_...`.
- `GET /api/v1/transcription/jobs` — list token-owned transcription jobs, requires `Authorization: Bearer girke_...`.
- `POST /api/v1/transcription/jobs` — create async transcription job, optional `webhook_url`, requires `Authorization: Bearer girke_...`.
- `GET /api/v1/transcription/jobs/:job_id` — job status/progress, owner-only.
- `GET /api/v1/transcription/jobs/:job_id/result` — completed transcript result, owner-only.
- `DELETE /api/v1/transcription/jobs/:job_id` — cancel queued/processing job, owner-only.
- `GET /api/v1/ocr` — OCR metadata, requires `Authorization: Bearer girke_...`.
- `POST /api/v1/ocr` — sync OCR for one supported image, requires `Authorization: Bearer girke_...`.
- `GET /api/v1/feeds/` — feed list placeholder, requires `Authorization: Bearer girke_...`.
