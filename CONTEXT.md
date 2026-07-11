# Girke API

Girke API is a private capability gateway for local AI utilities and small public integration endpoints.

## Language

**Capability Endpoint**:
A top-level API capability exposed to clients, such as transcription, OCR, redaction, chat, coding, or video processing. Supporting HTTP routes for jobs, status, or retrieval belong to the capability endpoint and do not count as separate endpoints.
_Avoid_: Endpoint when counting every HTTP route.

**Language Hint**:
A client-provided transcription language preference. `auto` means no language is forced and language detection is allowed; it is also the default when omitted.
_Avoid_: Language when referring to the client's optional preference.

**Detected Language**:
The language identified by the transcription model for the processed media. It can differ from the language hint when the hint is `auto`.
_Avoid_: Language hint when referring to model output.

**Sync Duration Limit**:
The maximum media duration accepted by the synchronous transcription route. Media above this limit must be submitted as an asynchronous transcription job.
_Avoid_: File size limit when the rule is based on duration.

**Transcription Job**:
A durable asynchronous request to transcribe uploaded media. It owns progress, completion state, and the final transcript output.
_Avoid_: Request when referring to long-running transcription work.

**Job Result**:
The final transcript output of a completed transcription job. It is not available while a job is queued or processing.
_Avoid_: Partial result for in-progress chunk output.

**Job Cancellation**:
A client request to stop an asynchronous transcription job before completion. Queued jobs can stop immediately; processing jobs stop after the current chunk boundary.
_Avoid_: Deletion when the job record and history remain available.

**Stored Media**:
Uploaded and derived media files retained for a transcription job outside the database. The database stores paths and metadata, while the filesystem volume stores bytes.
_Avoid_: Blob when media is not stored inside Postgres.

**Media Cleanup**:
Removal of uploaded and derived media files after a transcription job reaches a terminal state. Cleanup preserves job metadata and transcript result while reclaiming filesystem storage.
_Avoid_: Job deletion.

**Debug Media Retention**:
An operator-controlled mode that keeps job media files after terminal status for inspection. It is disabled by default and exists for debugging failed or suspicious transcription jobs.
_Avoid_: Normal retention policy.

**API Token**:
A bearer credential that identifies an API client across the Girke API. Transcription jobs created with a token are owned by that token and are only readable or cancellable through that token.
_Avoid_: Global API key when multiple clients need separated access.

**Route Schema**:
A Zod-backed description of one HTTP route's accepted input and documented output contract. Girke API uses route schemas as the source of truth for request validation and API documentation.
_Avoid_: Handler-only route when the route is part of the public API.

**OpenAPI Document**:
The generated JSON contract describing Girke API routes, authentication, request shapes, and response shapes. It is consumed by API reference tools and client generators.
_Avoid_: YAML spec when referring to the runtime API contract.

**API Reference**:
The browsable documentation UI generated from the OpenAPI document. It describes how to call the API but does not grant access to protected data.
_Avoid_: Swagger when referring to the general documentation experience.
