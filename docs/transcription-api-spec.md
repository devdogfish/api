# Transcription API Spec

> **For Hermes:** Use `subagent-driven-development` when implementing this plan. Build this as an incremental upgrade to the existing Girke API transcription routes.

**Goal:** Provide a production-shaped transcription API that supports short synchronous transcriptions and reliable long-running async transcription jobs for meetings, videos, and podcasts.

**Architecture:** Keep the existing sync endpoint for short clips. Add a job-based async workflow for longer media: upload once, persist a job record, process in a background worker, store progress/results, and expose status/result endpoints. Internally normalize media, chunk long audio, transcribe chunks, and stitch final text with timestamps.

**Accuracy levels:**
- `high`: best available model that works reliably on the machine; prioritize quality over latency.
- `medium`: faster model with still-good English/German output.
- `low`: fastest usable model; speed is the main priority and accuracy can be lower.

---

## Why async jobs are needed

A single HTTP request that uploads an MP3 and waits 30-60+ minutes is acceptable only for internal smoke testing. It is not the right product/API shape for long media.

Problems with long blocking requests:

- client/proxy/mobile network timeouts
- no progress visibility
- retries restart the whole transcription
- upload must be repeated after failures
- weak user experience
- hard to resume partially completed work

Industry-standard transcription APIs usually use async jobs for long media:

1. create/upload job
2. poll status or receive webhook
3. fetch result when complete

---

## API surface

All protected Girke API routes require centralized API token authentication:

```http
Authorization: Bearer girke_...
```

Tokens are stored hashed in Postgres and apply across the entire Girke API, not only transcription. A transcription job is owned by the API token that created it, and status/result/cancel operations must only work for the owning token.

Generated token values use the simple `girke_<random>` format, are shown once, and are stored only as hashes with name, created time, and optional revoked time.

`/api/v1/oona/contact` remains an explicit public exception and does not require an API token.

Token management is admin-only through CLI tasks, not public HTTP:

```bash
bun run tokens:create <name>
bun run tokens:revoke <id>
```

### 1. Synchronous transcription for short clips

Keep the existing endpoint for short clips and tests.

```http
POST /api/v1/transcription/transcribe
```

Recommended use:

- voice notes
- clips under 2-5 minutes
- quick smoke tests
- internal benchmarking

Example:

```bash
curl -X POST "https://api.girke.dev/api/v1/transcription/transcribe" \
  -H "Authorization: Bearer $GIRKE_API_TOKEN" \
  -F "file=@meeting_excerpt.mp3" \
  -F "level=high" \
  -F "language=en"
```

Expected response:

```json
{
  "text": "...",
  "segments": [
    {
      "start": 0.0,
      "end": 4.2,
      "text": "..."
    }
  ],
  "duration_seconds": 120.0,
  "processing_seconds": 85.4,
  "level": "high",
  "language": "auto",
  "detected_language": "en",
  "model": "selected-model-name"
}
```

Recommended server behavior:

- reject or redirect long media to async jobs when duration exceeds the configured sync limit
- default sync max duration: `300` seconds
- keep the existing request body size cap for synchronous transcription
- return `413` or `422` with guidance to use `/jobs` for long media

---

### 2. Async job creation for meetings/videos

```http
POST /api/v1/transcription/jobs
```

Request options:

- multipart upload: `file=@meeting.mp3`
- transcription level: `level=high|medium|low`
- language hint: `language=en|de|auto`
- optional callback URL: `webhook_url=https://...`

Limits:

- max async upload size: `2GB`
- max async media duration: `4h`
- return `413` when upload size exceeds the limit
- return `422` when media duration exceeds the limit
- return `415` for unsupported media extensions
- return `422` for media decode/normalization failures

Example:

```bash
curl -X POST "https://api.girke.dev/api/v1/transcription/jobs" \
  -H "Authorization: Bearer $GIRKE_API_TOKEN" \
  -F "file=@meeting.mp3" \
  -F "level=high" \
  -F "language=en"
```

Response:

```json
{
  "job_id": "tr_01jzexample",
  "status": "queued",
  "level": "high",
  "language": "auto",
  "detected_language": null,
  "created_at": "2026-07-11T00:00:00Z",
  "status_url": "/api/v1/transcription/jobs/tr_01jzexample",
  "result_url": "/api/v1/transcription/jobs/tr_01jzexample/result"
}
```

---

### 3. Job status endpoint

```http
GET /api/v1/transcription/jobs/:job_id
```

Response while queued:

```json
{
  "job_id": "tr_01jzexample",
  "status": "queued",
  "progress": 0,
  "created_at": "2026-07-11T00:00:00Z",
  "updated_at": "2026-07-11T00:00:00Z"
}
```

Response while processing:

```json
{
  "job_id": "tr_01jzexample",
  "status": "processing",
  "progress": 0.42,
  "current_chunk": 14,
  "total_chunks": 33,
  "duration_seconds": 1980.5,
  "processing_seconds_elapsed": 732.1,
  "level": "high",
  "language": "auto",
  "detected_language": null,
  "model": "selected-model-name",
  "created_at": "2026-07-11T00:00:00Z",
  "started_at": "2026-07-11T00:01:00Z",
  "updated_at": "2026-07-11T00:13:12Z"
}
```

Response after completion:

```json
{
  "job_id": "tr_01jzexample",
  "status": "completed",
  "progress": 1,
  "duration_seconds": 1980.5,
  "processing_seconds": 3637.2,
  "detected_language": "en",
  "created_at": "2026-07-11T00:00:00Z",
  "started_at": "2026-07-11T00:01:00Z",
  "completed_at": "2026-07-11T01:01:37Z",
  "updated_at": "2026-07-11T01:01:37Z",
  "result_url": "/api/v1/transcription/jobs/tr_01jzexample/result"
}
```

Response after failure:

```json
{
  "job_id": "tr_01jzexample",
  "status": "failed",
  "progress": 0.36,
  "error": {
    "code": "TRANSCRIPTION_WORKER_FAILED",
    "message": "Worker failed while processing chunk 12"
  }
}
```

Unknown jobs return `404`. Jobs owned by a different API token should also behave as not found.

---

### 4. Job result endpoint

```http
GET /api/v1/transcription/jobs/:job_id/result
```

Response:

```json
{
  "job_id": "tr_01jzexample",
  "status": "completed",
  "text": "Full stitched transcript...",
  "segments": [
    {
      "start": 0.0,
      "end": 3.8,
      "text": "...",
      "chunk_index": 0
    }
  ],
  "duration_seconds": 1980.5,
  "processing_seconds": 3637.2,
  "level": "high",
  "language": "auto",
  "detected_language": "en",
  "model": "selected-model-name"
}
```

If the job is queued or processing, return `409`:

```json
{
  "error": "job_not_completed",
  "status": "processing"
}
```

If the job failed, return `422` with the stored error. If the job was cancelled, return `410`:

```json
{
  "error": "job_cancelled"
}
```

There are no public partial transcripts in v1. Chunk text is stored internally only for retrying and stitching.

---

### 5. Job cancellation endpoint

```http
DELETE /api/v1/transcription/jobs/:job_id
```

Queued jobs cancel immediately. Processing jobs stop after the current chunk boundary. Cancellation keeps the job record and status history; it does not delete the job.

---

## Internal processing flow

For async jobs, the backend should:

1. authenticate request
2. store original uploaded media once
3. create a durable transcription job record
4. enqueue the job for background processing
5. normalize audio to mono 16k WAV
6. split long audio into chunks, e.g. 30-60 seconds
7. transcribe chunks
8. store chunk-level results and progress
9. stitch chunk text and timestamps
10. mark job completed or failed
11. optionally call a webhook callback

Processing rules:

- default chunk target: `60s`
- default chunk overlap: `5s`
- progress is completed chunks divided by total chunks
- progress stays below `1` until the final stitched transcript is persisted
- retry each failed chunk up to 3 attempts
- reuse successful chunk outputs on retry/resume
- after 3 failed attempts for one chunk, mark the job failed with `CHUNK_RETRY_EXHAUSTED`
- segment timestamps in the final result are absolute media seconds
- keep `chunk_index` in segment output for debugging
- one processing job runs at a time by default
- worker concurrency can become configurable later by environment variable
- unload the prior Whisper model before loading a different model to avoid RAM pressure

---

## Storage model

Minimum persistent fields for jobs:

```text
id
public_id
api_token_id
status: queued | processing | completed | failed | cancelled
level: high | medium | low
language: en | de | auto
detected_language
model
original_filename
input_path
normalized_audio_path
media_cleanup_status
result_json
progress
current_chunk
total_chunks
duration_seconds
processing_seconds
error_code
error_message
created_at
started_at
completed_at
updated_at
```

`public_id` is the externally visible job id, formatted as `tr_...`. Internal database integer ids must not be exposed.

Chunk records should include:

```text
job_id
chunk_index
start_seconds
end_seconds
status
text
segments_json
processing_seconds
error_message
```

Supported job error codes:

```text
UNSUPPORTED_MEDIA_FORMAT
MEDIA_NORMALIZATION_FAILED
MEDIA_DURATION_EXCEEDED
TRANSCRIPTION_WORKER_FAILED
CHUNK_RETRY_EXHAUSTED
JOB_CANCELLED
```

Webhook delivery failures are tracked separately from job status, e.g. `WEBHOOK_DELIVERY_FAILED` in webhook logs.

---

## Recommended implementation phases

### Phase 1: Make the current sync endpoint safe

- Enforce max sync duration or max file size.
- Return a clear error telling clients to use async jobs for long media.
- Keep `level` and `language` behavior identical to async jobs.

### Phase 2: Add local async jobs

- Add `POST /api/v1/transcription/jobs`.
- Store uploaded media in a Docker volume or configured upload directory.
- Persist job and chunk metadata in the existing Docker Postgres database via Drizzle.
- Store media bytes on the filesystem, with paths recorded in Postgres.
- Store final transcript result JSON in Postgres so result retrieval survives media cleanup.
- Start with an in-process worker in the `girke-api` service; split into a separate worker/container only when needed.
- Add status and result endpoints.

### Phase 3: Add chunking and resumability

- Normalize input media with ffmpeg.
- Split into chunks.
- Persist chunk progress.
- Retry failed chunks.
- Stitch text and timestamps.

### Phase 4: Add webhooks

- Accept optional `webhook_url` on job creation.
- POST completion/failure/cancellation payload when the job reaches a terminal status.
- Sign webhook payloads.
- Retry failed webhook delivery up to 5 times with exponential backoff.
- Never change the transcription job status because webhook delivery failed.

### Phase 5: Add media cleanup

- Delete uploaded and derived media files after the job reaches a terminal status and the transcript result is persisted.
- Preserve job metadata, status, timing, error details, and completed transcript result.
- Track cleanup state separately so cleanup failures can be retried without changing the job result.
- Add a debugging environment variable, e.g. `TRANSCRIPTION_KEEP_MEDIA=true`, that disables media deletion for inspection. Default is deletion enabled.

---

## Client guidance

Use sync endpoint only for short clips:

```text
POST /api/v1/transcription/transcribe
```

Use async jobs for real meetings/videos:

```text
POST /api/v1/transcription/jobs
GET /api/v1/transcription/jobs/:id
GET /api/v1/transcription/jobs/:id/result
```

Recommended polling behavior:

- poll every 5-10 seconds while queued/processing
- use exponential backoff after several minutes
- stop polling when status is `completed`, `failed`, or `cancelled`

---

## Acceptance criteria

- Short clips can still be transcribed synchronously.
- New response contracts are source of truth; do not preserve legacy sync response semantics.
- Long media can be uploaded once and processed as a background job.
- API clients can check progress without keeping the upload request open.
- Completed jobs expose full text, segments, model, language, duration, and processing time.
- Failed jobs expose a clear error code/message.
- Terminal jobs clean up uploaded/derived media files after preserving the result and metadata.
- The implementation supports English now and leaves a clear path for German testing/selection.
- Accuracy levels map to tested model choices for `high`, `medium`, and `low`.
