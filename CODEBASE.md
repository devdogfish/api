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
- `GET /api/v1/transcription`: protected transcription metadata, including levels, language hints, and media formats.
- `POST /api/v1/transcription/transcribe`: protected synchronous media transcription for shorter audio or video files.
- `GET /api/v1/transcription/jobs`: protected async transcription job list for the current token.
- `POST /api/v1/transcription/jobs`: protected async transcription upload; creates a queued background job.
- `GET /api/v1/transcription/jobs/{job_id}`: protected status and progress lookup for one transcription job.
- `DELETE /api/v1/transcription/jobs/{job_id}`: protected cancellation for queued or processing transcription jobs.
- `GET /api/v1/transcription/jobs/{job_id}/result`: protected final transcript retrieval; also reports pending, failed, or cancelled states.

## Webhooks

Use webhooks with async transcription jobs when clients need terminal job updates without polling.

- `transcription.job.completed`
- `transcription.job.failed`
- `transcription.job.cancelled`

For full endpoint details, read /openapi.json.
