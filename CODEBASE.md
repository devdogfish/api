# Girke API LLM Guide

Public API contract for Girke API.

## Documentation

- [OpenAPI JSON](/openapi.json): canonical OpenAPI 3.1 contract for schemas, status codes, and webhooks.
- [API Reference](/reference): interactive Scalar documentation.

## Auth

Protected endpoints use `bearerAuth`: `Authorization: Bearer <API Token>`.

## Endpoints

- `GET /`: public service identity and runtime version metadata.
- `GET /health`: public liveness check for deployment and proxy monitoring.
- `GET /version`: public deployed app version for release verification.
- `GET /openapi.json`: canonical OpenAPI 3.1 spec with schemas, responses, and webhooks.
- `GET /llms.txt`: compact agent index pointing to docs and route inventory.
- `GET /reference`: Scalar browser UI for humans exploring the API contract.
- `POST /api/v1/oona/contact`: public contact form proxy; validates input, sends email, and optionally subscribes.
- `GET /api/v1/feeds`: protected feed capability list for authenticated API clients.
- `GET /api/v1/ocr`: protected OCR metadata, including model, timeout, and accepted image formats.
- `POST /api/v1/ocr`: protected image OCR upload; returns recognized text and line-level results.
- `GET /api/v1/llm`: protected shared model metadata and limits (`llm` token scope).
- `POST /api/v1/llm/chat`: protected chat completion with optional `json_schema` or `grammar`; own queue; prompts never logged.
- `GET /api/v1/transcription`: protected transcription metadata, including levels, language hints, and media formats.
- `POST /api/v1/transcription/transcribe`: protected synchronous media transcription for shorter audio or video files.
- `GET /api/v1/transcription/jobs`: protected async transcription job list for the current token.
- `POST /api/v1/transcription/jobs`: protected async transcription upload; creates a queued background job.
- `GET /api/v1/transcription/jobs/{job_id}`: protected status and progress lookup for one transcription job.
- `DELETE /api/v1/transcription/jobs/{job_id}`: protected cancellation for queued or processing transcription jobs.
- `GET /api/v1/transcription/jobs/{job_id}/result`: protected final transcript retrieval; also reports pending, failed, or cancelled states.

## Compute admission

OCR and both transcription paths share one slot per app. Two direct requests and one async worker can wait. Full direct queues return 503 `compute_busy`. Accepted async jobs retain their existing backlog and API. Cancellation frees a wait; running work holds the slot until it settles. Startup resumes queued or expired jobs from matching saved chunks. Terminal results commit before media cleanup.

## Dashboard edge routes

- `POST https://dashboard.girke.dev/api/v1/website-analytics/events` forwards portfolio batches to the private analytics relay. Requires the relay’s dedicated `X-API-Key`.

## Webhooks

Use webhooks with async transcription jobs when clients need terminal job updates without polling.

- `transcription.job.completed`
- `transcription.job.failed`
- `transcription.job.cancelled`

For full endpoint details, read /openapi.json.
