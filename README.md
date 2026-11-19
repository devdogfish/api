# API operations

Permanent service for `api.girke.dev`, separate from the LLM Wiki app/API. The only shared piece is the existing Caddy reverse proxy container.

## Layout

- Host: Hostinger VPS (`ssh hostinger-vps`)
- Repo: `/root/api`
- API: Hono/TypeScript in `src/`
- Postgres: Docker Compose service `girke-api-postgres`
- Whisper sidecar: FastAPI service `girke-api-whisper`
- Public Caddy: Docker Compose service `girke-caddy`
- Route overview: `CODEBASE.md`

## Secrets/config

- Runtime env file: `/root/api/.env`
- API auth: Girke bearer tokens in Postgres. Create/revoke with `bun run tokens:create <name>` and `bun run tokens:revoke <id>`.
- Do not commit `.env`.

## Operations

```bash
cd /root/api
export PATH="$HOME/.bun/bin:$PATH"
bun test
bun run typecheck
docker compose -f docker-compose.yml -f docker-compose.hostinger.yml up -d postgres
docker compose -f docker-compose.yml -f docker-compose.hostinger.yml run --build --rm girke-api bun run db:migrate
docker compose -f docker-compose.yml -f docker-compose.hostinger.yml run --build --rm girke-api bun run tokens:create <name>
```

Database migrations are generated in `drizzle/`. Token values are printed once
and stored as hashes. Pushing `main` triggers an API and Whisper release to
Hostinger. The workflow stages the triggering revision separately, uses the
existing healthy PostgreSQL service, and verifies the API and rollback fence.
The shared Caddy and Boards services have their own maintenance window.

## Private redaction proof

In an offline development environment, stage Python 3.12 with PyMuPDF 1.27.2.3
and pypdf 7.1.0, Poppler, and Tesseract with English and German trained data.
Pass the Python executable and the merged Quantself synthetic PDF proof to the
disposable harness. [Source proof](https://github.com/devdogfish/quantself/pull/447)

```sh
bun scripts/prove-private-redaction.ts "$proof_python" "$quantself_proof"
```

The private executor is callable in process. A private composition must pass
the same `ComputeAdmission` to it and `createApp`, and supply a trusted redactor,
verifier, and private scratch directory. The harness uses generated documents
and keeps the source, mapping, and candidate in scratch until cleanup.

The in-process `createExactMatchPdfRedactor` caller accepts PDF bytes, an
exact-match dictionary, and safe text to retain on each page. It uses local
text extraction and Tesseract word boxes, produces fresh raster pages, and
independently checks decoded pixels, structure, and OCR before returning a
review candidate. It accepts up to eight unrotated pages without a separate
crop box, and requires English or German OCR data. The private caller owns
the scratch lifecycle. Review and export approval are separate.

```sh
bun scripts/prove-exact-match-redaction.ts "$proof_python"
```

Set `structuredIdentifiers: true` on the private caller to detect German IBANs,
personal IdNr, and common ASCII email addresses with dotted domains. This mode
can run with an empty exact-match dictionary. It recognizes compact and
grouped German IBANs, compact and 2-3-3-3 IdNr, and spaces around an OCR-split
`@`.
A bad checksum on a supported numeric shape or a surviving unresolved `@`
blocks verification. Checksums validate structure. Detection depends on text
extraction and OCR. Use the exact-match dictionary for known values outside
these shapes, including other countries' IBANs. Phone detection has a separate opt-in.

```sh
bun scripts/prove-structured-redaction.ts "$proof_python"
```

The private owner workflow can use `createPrivatePdfReview` with the shared
admission gate and owner-only scratch. `prepare` creates a side-by-side PDF with
the original and the independently verified candidate, with outlines at the
redaction locations. Treat that preview as original data. Use `inspect` to
obtain the exact preview bytes and digests, then pass that inspection to
`approve` after review. `readApprovedCandidate` consumes the approval and hands
back the exact, rechecked candidate bytes. Each approval applies to one
preparation in the current process. Call `discard` to remove its private files.
Pass `{ vaultRoot }` to enable placeholders. Use an owner-only Vault directory
outside scratch and Work. Exact entries default to `[IDENTIFIER_n]` and may be
typed as `PERSON` with a parallel `identifierTypes` array. Structured entries
use `[IBAN_n]`, `[TAX_ID_n]` and `[EMAIL_n]`. Repeated normalized values on a
document share a label. Supported wraps can span adjacent lines on one page.
Conflicting regions and unreadably small replacements are refused.

The worker writes the private reverse mapping directly to Vault. The review
checks the mapping digest with the PDF and preview digests. Discard removes an
unhanded draft's mapping. After reading the approved candidate, the owner can
find its mapping at `<vaultRoot>/<candidateSha256>/mapping.json`. Prepare again
and obtain fresh approval when revising a draft.

For a local Work handoff, configure `{ vaultRoot, workRoot }` and call
`exportApprovedCandidate` with the inspection's approval. Use an existing
Work directory owned by the caller with the intended reader group and mode
`2750` on Linux or `0750` on macOS. Resolved Work, scratch and Vault paths must have trusted ancestry
owned by root or the caller. Group or other writable ancestors must be sticky.
The caller rejects overlap, including symlink aliases, before preparing and
exporting. The handoff consumes one approval and links the complete
digest-named PDF at mode `0640`, leaving any existing export intact. The reverse
map stays private in Vault even if publication fails. Use separate Work and Vault
mounts without ACLs that grant additional access. Work must support atomic
file linking and group access.

```sh
bun scripts/prove-private-pdf-review.ts "$proof_python"
bun scripts/prove-vault-placeholders.ts "$proof_python"
```

The disposable permission proof uses separate Work and Vault tmpfs mounts,
a Work reader in its own group, and a separate mapping owner. With Work owned
by the caller and setgid to the reader group at mode `2750`, the reader can
read the exact approved PDF under both caller umasks `0027` and `0077`. The
reader cannot write to the PDF or read the private mapping. The mapping stays
accessible to its owner in both cases.

Run with the staged aggregate proof image and the source checkout mounted read-only.
Copy the proof into a disposable writable tmpfs for Bun's inline script and
check that the image's installed dependencies use the checkout's lockfile.

```sh
docker run --rm --pull=never --platform linux/amd64 --network none \
  --mount "type=bind,source=$PWD,target=/source,readonly" --workdir /fixture \
  --tmpfs /fixture:rw,nosuid,nodev,mode=1777 \
  --tmpfs /fixture-work:rw,nosuid,nodev,mode=0711 --tmpfs /fixture-vault:rw,nosuid,nodev,mode=0711 \
  --entrypoint sh girke-213-aggregate-proof:407c8bb7 -ec '
    cmp /source/bun.lock /app/bun.lock
    cp -R /source/src /source/scripts /source/package.json .
    ln -s /app/node_modules node_modules
    exec python scripts/prove-work-vault-permissions.py
  '
```

Pass `{ paddleModels }` to the private caller to use local PP-OCRv5 mobile word
boxes for raster-page detection, including scans. It can be combined with
`vaultRoot` on `createPrivatePdfReview`. Stage PaddlePaddle 3.3.1, PaddleOCR 3.7.0,
PaddleX 3.7.2 and the extracted detection and recognition models. Use the
public archive checksums from the [Quantself synthetic proof](https://github.com/devdogfish/quantself/pull/447).
A configured job fails on missing assets or unusable geometry. One CPU model
instance handles all pages of that job and exits before independent Poppler
and Tesseract verification. Run the private worker with network access denied.

```sh
sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  bun scripts/prove-paddle-pdf-scans.ts "$proof_python" "$paddle_models"
```

The proof reports model initialization plus first-page detection as cold,
second-page detection in the same worker as warm, end-to-end preparation time,
and redactor peak RSS. On native macOS arm64, the two-page synthetic scan
measured 7.91 s cold, 2.51 s warm, 12.75 s through review preparation, and
1,413 MiB redactor peak RSS. The audit rejected a planted line-wrap miss.
Use a network-disabled container for the equivalent Linux proof.
Qualification under the shared Keep memory limit requires a separate run.

Enable `personNames: true` on `createPrivatePdfReview` with an owner-only
`vaultRoot`. The job language selects English `en_core_web_sm` (PERSON) or
German `de_core_news_sm` (PER). Stage spaCy 3.8.18 and both 3.8.0 wheels outside
the repo. Check the wheel digests against the official releases before installing
them. [English model release](https://github.com/explosion/spacy-models/releases/tag/en_core_web_sm-3.8.0)
· [German model release](https://github.com/explosion/spacy-models/releases/tag/de_core_news_sm-3.8.0)

- English SHA-256 `1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85`
- German SHA-256 `fec69fec52b1780f2d269d5af7582a5e28028738bd3190532459aeb473bfa3e7`

The name model runs on the text layer and raster transcription. Exact and
structured detections take precedence over contained name spans. Independent
verification re-transcribes the final rasters with Tesseract, checks all detected
person values as exact terms, and tests the new text for person spans. The model
can miss a name in both passes. The Owner-labeled evaluation remains a release gate.

```sh
sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  bun scripts/prove-person-names.ts "$proof_python" "$paddle_models"
```

On native macOS arm64 with network access denied, the four labeled pages
contained eight name occurrences. spaCy found four full names and produced
zero extra person spans. The exact fallback covered the four misses.
Independent OCR found zero labeled names in approved output. The audit refused
a planted residual name. Conflicting name spans and missing Vault configuration
also failed closed.

| Two-page document | Preparation | spaCy load + inference CPU | Redactor peak RSS with Paddle |
| --- | ---: | ---: | ---: |
| English | 12.63 s | 1.207 s | 1,462 MiB |
| German | 12.16 s | 1.198 s | 1,663 MiB |

Set `phoneRegions` on `createPrivatePdfReview` to opt in with an owner-only
`vaultRoot`. Supply up to three explicit libphonenumber region codes.
An empty list enables international `+` numbers only. Stage
`phonenumbers==9.0.43` with wheel SHA-256
`349bc799f15e010e35bd2c7d28149950ae74479cb1e11fb054ed9a95ecb4b437`.
[Release and checksum](https://pypi.org/project/phonenumbers/9.0.43/)

The detector requires numbering-plan validity and 7–15 digits in the
international form. A national number needs a nearby English or German phone cue, such as
`Tel:`, or a parenthesized area code. Matches may wrap over two adjacent
lines on one page. Partial and conflicting interpretations are refused.
Regional dial-out prefixes, bare subscriber numbers, short codes and
vanity numbers remain exact-list cases. Number-plan checks do not establish
assignment or reachability. The parser is bounded to 65,536 characters and
4,096 digit groups per page transcription.

Equivalent formats share a `[PHONE_n]` label and an E.164 value in the private
mapping. Parsed extensions are retained there as `;ext=`. Independent
Tesseract verification checks phone matches again and recognizes mapped base
numbers even if their phone cue is missing.

```sh
sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  bun scripts/prove-phone-numbers.ts "$proof_python" "$paddle_models"
```

The network-disabled macOS arm64 proof removed eight labeled occurrences
across a text page and a Paddle scan. A date and a phone-shaped ID survived,
and the verifier refused a planted residual. Preparation took 11.56 s.
The redactor spent 42.9 ms of CPU on parser startup and seven calls.

The [aggregate queue proof](scripts/aggregate-proof/README.md) runs the current
private caller with retained Whisper and measures the entire workload against
the offline Linux memory and CPU budget.

## Public routing

Hostinger's Caddy routes `api.girke.dev` to `girke-api:3000` over the shared
external Docker network `girke-edge`. The legacy Quantself dashboard on
`dashboard.girke.dev` is fenced for rollback and returns HTTP 503 at `/` and
`/api/health`. Quantself dashboard traffic moved to Keep in the
[home cutover](https://github.com/devdogfish/quantself/issues/209).

## Endpoint inventory

Base URL: `https://api.girke.dev`

Public routes:

- `GET /` — service identity: `{ name, internal, version }`.
- `GET /health` — health check: `{ ok: true }`.
- `GET /version` — configured app version.
- `OPTIONS /api/v1/oona/contact` — Carrd/browser CORS preflight.
- `POST /api/v1/oona/contact` — public Oona Kokopelli contact form endpoint; no API token required.

Protected routes requiring `Authorization: Bearer girke_...`:

- `GET /api/v1/transcription` — transcription capability metadata: levels, languages, accepted media formats.
- `POST /api/v1/transcription/transcribe` — synchronous multipart transcription for short supported audio/video files.
- `GET /api/v1/transcription/jobs` — list transcription jobs owned by the API token.
- `POST /api/v1/transcription/jobs` — create an async transcription job for longer media.
- `GET /api/v1/transcription/jobs/:job_id` — read async job status/progress.
- `GET /api/v1/transcription/jobs/:job_id/result` — read completed transcript result.
- `DELETE /api/v1/transcription/jobs/:job_id` — cancel queued/processing async job.
- `GET /api/v1/ocr` — OCR capability metadata: fixed model, timeout, upload limit, accepted image formats.
- `POST /api/v1/ocr` — synchronous multipart OCR for one supported image.
- `GET /api/v1/feeds` — placeholder feed list, currently returns `{ feeds: [] }`.

Internal Docker-only sidecar routes, not public internet endpoints:

- `GET http://whisper:8000/health`
- `GET http://whisper:8000/models`
- `POST http://whisper:8000/transcribe`

## Audio/video transcription

Protected capability endpoint for short/medium audio/video transcription:

```text
POST https://api.girke.dev/api/v1/transcription/transcribe
Authorization: Bearer girke_...
Content-Type: multipart/form-data
```

Long media should use async jobs:

```text
POST https://api.girke.dev/api/v1/transcription/jobs
GET https://api.girke.dev/api/v1/transcription/jobs/:job_id
GET https://api.girke.dev/api/v1/transcription/jobs/:job_id/result
DELETE https://api.girke.dev/api/v1/transcription/jobs/:job_id
```

Async jobs store uploaded media once, process chunks in the background, expose progress, preserve final JSON results, and clean up media by default. Optional `webhook_url=https://...` receives signed terminal payloads for completed, failed, and cancelled jobs.

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

Current CPU-only model tiers were benchmarked with `faster-whisper`, `int8`, and
4 CPU threads:

- `low`: `base` — fastest reliable tier; better than `tiny` on German in local tests.
- `medium`: English `distil-small.en`, German/auto `small` — good output while still practical on CPU.
- `high`: `large-v3-turbo` — best practical model verified on this machine; slower but works for English and German.

Metadata:

```text
GET https://api.girke.dev/api/v1/transcription
Authorization: Bearer girke_...
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
  "segments": [{ "start": 0, "end": 2.74, "text": "Transcribed text..." }],
  "duration_seconds": 2.74,
  "processing_seconds": 1.21,
  "level": "medium",
  "language": "auto",
  "detected_language": "en",
  "model": "distil-small.en"
}
```

## OCR recognition

Protected synchronous OCR endpoint for one image:

```text
POST https://api.girke.dev/api/v1/ocr
Authorization: Bearer girke_...
Content-Type: multipart/form-data
```

Multipart fields:

```text
file=image file, required
```

Accepted input formats:

```text
jpg, jpeg, png, webp, tif, tiff, bmp
```

OCR uses the fixed `tesseract-latin-psm11-gray` strategy with a 20 second processing timeout.

Metadata:

```text
GET https://api.girke.dev/api/v1/ocr
Authorization: Bearer girke_...
```

Response body:

```json
{
  "model": "tesseract-latin-psm11-gray",
  "timeout_seconds": 20,
  "max_upload_bytes": 26214400,
  "accepted_image_formats": ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"]
}
```

OCR response body:

```json
{
  "text": "LOT 1234\nBest before 2027",
  "lines": ["LOT 1234", "Best before 2027"],
  "processing_seconds": 2.6,
  "model": "tesseract-latin-psm11-gray"
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

CORS allows browser requests from `https://gallery.oonakokopelli.com`. The route is intentionally public and does not require a Girke API token; protected internal routes still do.

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
