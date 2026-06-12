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
SENDER_API_TOKEN=...
CONTACT_RECEIVING_EMAIL=studio@oonakokopelli.com
CONTACT_FROM_EMAIL=studio@oonakokopelli.com # optional, defaults to receiving email
SENDER_GROUP_ID=...
```
