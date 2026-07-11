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
  -H "X-API-Key: $GIRKE_API_KEY" \
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
  "language": "en",
  "model": "selected-model-name"
}
```

Recommended server behavior:

- reject or redirect long media to async jobs when duration exceeds the configured sync limit
- default sync max duration: `300` seconds
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

Example:

```bash
curl -X POST "https://api.girke.dev/api/v1/transcription/jobs" \
  -H "X-API-Key: $GIRKE_API_KEY" \
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
  "language": "en",
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
  "created_at": "2026-07-11T00:00:00Z"
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
  "language": "en",
  "model": "selected-model-name"
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
  "language": "en",
  "model": "selected-model-name"
}
```

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

---

## Storage model

Minimum persistent fields for jobs:

```text
id
status: queued | processing | completed | failed | cancelled
level: high | medium | low
language: en | de | auto
model
original_filename
input_path
normalized_audio_path
result_path
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

---

## Recommended implementation phases

### Phase 1: Make the current sync endpoint safe

- Enforce max sync duration or max file size.
- Return a clear error telling clients to use async jobs for long media.
- Keep `level` and `language` behavior identical to async jobs.

### Phase 2: Add local async jobs

- Add `POST /api/v1/transcription/jobs`.
- Store uploaded media in a Docker volume or configured upload directory.
- Persist job metadata.
- Run background worker in-process or as a sidecar process.
- Add status and result endpoints.

### Phase 3: Add chunking and resumability

- Normalize input media with ffmpeg.
- Split into chunks.
- Persist chunk progress.
- Retry failed chunks.
- Stitch text and timestamps.

### Phase 4: Add webhooks

- Accept optional `webhook_url` on job creation.
- POST completion/failure payload when the job finishes.
- Sign webhook payloads if exposed to third parties.

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
- Long media can be uploaded once and processed as a background job.
- API clients can check progress without keeping the upload request open.
- Completed jobs expose full text, segments, model, language, duration, and processing time.
- Failed jobs expose a clear error code/message.
- The implementation supports English now and leaves a clear path for German testing/selection.
- Accuracy levels map to tested model choices for `high`, `medium`, and `low`.
