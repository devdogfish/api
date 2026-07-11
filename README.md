# API operations

Permanent service for `api.girke.dev`, separate from the LLM Wiki app/API. The only shared piece is the existing Caddy reverse proxy container.

## Layout

- Repo: `/home/ubuntu/api`
- API: Hono/TypeScript in `src/`
- Postgres: Docker Compose service `girke-api-postgres`
- Whisper sidecar: FastAPI service `girke-api-whisper`
- Route overview: `CODEBASE.md`

## Secrets/config

- Runtime env file: `/home/ubuntu/api/.env`
- API auth: static `X-API-Key` header from `.env`
- Do not commit `.env`.

## Operations

```bash
cd /home/ubuntu/api
export PATH="$HOME/.bun/bin:$PATH"
bun test
bun run typecheck
docker compose up -d --build
```

Database migrations are generated in `drizzle/`. Current migration was applied to the Compose Postgres container.

## Public routing

Caddy routes `api.girke.dev` to Docker service `girke-api:3000` on the existing external Docker network `llmwiki`. No random public app port is opened. DNS and TLS are live for `https://api.girke.dev`.

## Endpoint inventory

Base URL: `https://api.girke.dev`

Public routes:

- `GET /` — service identity: `{ name, internal, version }`.
- `GET /health` — health check: `{ ok: true }`.
- `GET /version` — configured app version.
- `OPTIONS /api/v1/oona/contact` — Carrd/browser CORS preflight.
- `POST /api/v1/oona/contact` — public Oona Kokopelli contact form endpoint; no API key required.

Protected routes requiring `X-API-Key`:

- `GET /api/v1/transcription` — transcription capability metadata: levels, languages, accepted media formats.
- `GET /api/v1/transcription/jobs` — placeholder job list, currently returns `{ jobs: [] }`.
- `POST /api/v1/transcription/transcribe` — multipart upload transcription for supported audio/video files.
- `GET /api/v1/feeds` — placeholder feed list, currently returns `{ feeds: [] }`.

Internal Docker-only sidecar routes, not public internet endpoints:

- `GET http://whisper:8000/health`
- `GET http://whisper:8000/models`
- `POST http://whisper:8000/transcribe`

## Audio/video transcription

Protected capability endpoint for short/medium audio/video transcription:

```text
POST https://api.girke.dev/api/v1/transcription/transcribe
X-API-Key: ...
Content-Type: multipart/form-data
```

Multipart fields:

```text
file=audio or video file, required
level=low|medium|high, optional, default medium
language=en|de|english|german|deutsch, optional; omit for auto-detect
```

Accepted input formats:

```text
audio: wav, mp3, m4a, aac, ogg, opus, flac, webm
video: mp4, mov, mkv, webm, avi
```

The sidecar normalizes every accepted upload through a shared `ffmpeg` helper before model inference: audio is extracted if needed, video streams are dropped, and the model receives mono 16 kHz WAV.

Current CPU-only ARM64 model tiers were benchmarked locally with `faster-whisper`, `int8`, and 4 CPU threads:

- `low`: `base` — fastest reliable tier; better than `tiny` on German in local tests.
- `medium`: English `distil-small.en`, German/auto `small` — good output while still practical on CPU.
- `high`: `large-v3-turbo` — best practical model verified on this machine; slower but works for English and German.

Metadata:

```text
GET https://api.girke.dev/api/v1/transcription
X-API-Key: ...
```

Response body:

```json
{
  "levels": ["low", "medium", "high"],
  "languages": [
    { "code": "en", "name": "English" },
    { "code": "de", "name": "German" }
  ],
  "default_level": "medium",
  "language_optional": true,
  "accepted_media": {
    "audio": ["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "webm"],
    "video": ["mp4", "mov", "mkv", "webm", "avi"]
  }
}
```

Transcription response body:

```json
{
  "text": "Transcribed text...",
  "language": "en",
  "duration_seconds": 2.74,
  "level": "medium",
  "model": "distil-small.en"
}
```

## Oona Kokopelli contact form

Public endpoint for the Carrd landing page at `https://gallery.oonakokopelli.com`:

```text
POST https://api.girke.dev/api/v1/oona/contact
Content-Type: application/json
```

Request body:

```json
{
  "name": "Jane Painter",
  "email": "jane@example.com",
  "message": "I love this work. Can I buy a print?",
  "subscribe": true
}
```

Response body:

```json
{ "success": true }
```

Errors use the same shape with a safe code:

```json
{ "success": false, "error": "invalid_request" }
```

CORS allows browser requests from `https://gallery.oonakokopelli.com`. The route is intentionally public and does not require `X-API-Key`; protected internal routes still do.

Required runtime env vars:

```text
# Newsletter signup only; keeps marketing in Sender.net
SENDER_API_TOKEN=...
SENDER_GROUP_ID=...

# Contact notification email; sends via Infomaniak SMTP, not Sender.net
CONTACT_RECEIVING_EMAIL=studio@oonakokopelli.com
CONTACT_FROM_EMAIL=website@oonakokopelli.com
CONTACT_SMTP_HOST=mail.infomaniak.com
CONTACT_SMTP_PORT=465
CONTACT_SMTP_SECURE=true
CONTACT_SMTP_USER=website@oonakokopelli.com
CONTACT_SMTP_PASSWORD=...
```

Contact emails are delivered with `From: Oona Kokopelli Website <CONTACT_FROM_EMAIL>` and `Reply-To` set to the visitor's submitted email. Newsletter opt-ins are still added to the configured Sender.net group.
