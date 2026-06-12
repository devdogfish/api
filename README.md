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

Caddy routes `api.girke.dev` to Docker service `girke-api:3000` on the existing external Docker network `llmwiki`. No random public app port is opened.

DNS still needs an `A` record:

```text
api.girke.dev -> 140.238.145.241
```

Once DNS propagates, Caddy should issue TLS automatically.
