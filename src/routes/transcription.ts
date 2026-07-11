import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { z } from 'zod'
import type { AppEnv } from '../appEnv'
import { createJsonResponse, PROTECTED_BEARER_SECURITY, TRANSCRIPTION_TAG, unauthorizedErrorResponse } from '../openapi'
import {
  createFfmpegMediaProcessor,
  createFfmpegDurationProbe,
  TranscriptionMediaProcessorError,
  type PreparedTranscriptionMedia,
  type TranscriptionDurationProbe,
  type TranscriptionMediaChunk,
  type TranscriptionMediaProcessor
} from '../transcription/mediaProcessor'
import {
  createTranscriptionMetadataResponse,
  DEFAULT_TRANSCRIPTION_LEVEL,
  SUPPORTED_MEDIA_EXTENSIONS,
  TRANSCRIPTION_LANGUAGE_HINTS,
  TRANSCRIPTION_JOB_STATUSES,
  transcriptionMetadataResponseExample,
  transcriptionMetadataResponseSchema,
  TRANSCRIPTION_LEVELS,
  type TranscriptionJobStatus,
  type TranscriptionLanguage,
  type TranscriptionLevel
} from './transcriptionContract'

export type { TranscriptionJobStatus, TranscriptionLanguage, TranscriptionLevel } from './transcriptionContract'

const DEFAULT_SYNC_MAX_UPLOAD_BYTES = 250 * 1024 * 1024
const DEFAULT_SYNC_MAX_DURATION_SECONDS = 300
const DEFAULT_ASYNC_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_ASYNC_MAX_DURATION_SECONDS = 4 * 60 * 60
const TRANSCRIPTION_JOB_ERROR_CODES = [
  'UNSUPPORTED_MEDIA_FORMAT',
  'MEDIA_NORMALIZATION_FAILED',
  'MEDIA_DURATION_EXCEEDED',
  'TRANSCRIPTION_WORKER_FAILED',
  'CHUNK_RETRY_EXHAUSTED',
  'JOB_CANCELLED'
] as const

export type TranscriptionFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>

const transcriptionJobsPath = '/api/v1/transcription/jobs'
const transcriptionSyncResponseExample = {
  text: 'hello',
  segments: [{ start: 0, end: 0.5, text: 'hello' }],
  duration_seconds: 0.5,
  processing_seconds: 0.2,
  level: 'medium',
  language: 'auto',
  detected_language: 'en',
  model: 'distil-small.en'
} as const

const transcriptionSegmentSchema = z
  .object({
    start: z.number().openapi({ example: transcriptionSyncResponseExample.segments[0].start, description: 'Segment start time in seconds.' }),
    end: z.number().openapi({ example: transcriptionSyncResponseExample.segments[0].end, description: 'Segment end time in seconds.' }),
    text: z.string().openapi({ example: transcriptionSyncResponseExample.segments[0].text, description: 'Transcript text for the segment.' })
  })
  .openapi('TranscriptionSegment')

const whisperTranscriptionResponseSchema = z
  .object({
    text: z.string().openapi({ example: transcriptionSyncResponseExample.text, description: 'Full transcript text for the uploaded media.' }),
    segments: z.array(transcriptionSegmentSchema).openapi({
      example: transcriptionSyncResponseExample.segments,
      description: 'Timestamped transcript segments in playback order.'
    }),
    duration_seconds: z.number().openapi({
      example: transcriptionSyncResponseExample.duration_seconds,
      description: 'Media duration in seconds.'
    }),
    processing_seconds: z.number().openapi({
      example: transcriptionSyncResponseExample.processing_seconds,
      description: 'Transcription processing time in seconds.'
    }),
    level: z.enum(TRANSCRIPTION_LEVELS).openapi({
      example: transcriptionSyncResponseExample.level,
      description: 'Normalized transcription level used for the request.'
    }),
    language: z.enum(TRANSCRIPTION_LANGUAGE_HINTS).openapi({
      example: transcriptionSyncResponseExample.language,
      description: 'Normalized request Language Hint used for the transcription.'
    }),
    detected_language: z.string().nullable().openapi({
      example: transcriptionSyncResponseExample.detected_language,
      description: 'Detected Language returned by the model, when available.'
    }),
    model: z.string().openapi({
      example: transcriptionSyncResponseExample.model,
      description: 'Transcription model identifier returned by the sidecar.'
    })
  })
  .openapi('TranscriptionSyncResponse', {
    description: 'Synchronous transcription result for a short clip upload.'
  })

type WhisperTranscriptionResponse = z.infer<typeof whisperTranscriptionResponseSchema>

class TranscriptionWorkerError extends Error {
  constructor(
    readonly code: TranscriptionJobErrorCode,
    message: string
  ) {
    super(message)
  }
}

export type TranscriptionSegment = {
  start: number
  end: number
  text: string
  chunk_index?: number
}

export type TranscriptionResultSegment = Omit<TranscriptionSegment, 'chunk_index'> & {
  chunk_index: number
}

export type TranscriptionResult = {
  text: string
  segments: TranscriptionResultSegment[]
  duration_seconds: number
  processing_seconds: number
  level: TranscriptionLevel
  language: TranscriptionLanguage
  detected_language: string | null
  model: string
}

export type TranscriptionJobRecord = {
  id?: number
  publicId: string
  apiTokenId: number
  status: TranscriptionJobStatus
  level: TranscriptionLevel
  language: TranscriptionLanguage
  detectedLanguage: string | null
  model: string | null
  originalFilename: string
  inputPath: string
  normalizedAudioPath: string | null
  mediaCleanupStatus: 'pending' | 'deleted' | 'kept' | 'failed'
  resultJson: TranscriptionResult | null
  progress: number
  currentChunk: number | null
  totalChunks: number | null
  durationSeconds: number | null
  processingSeconds: number | null
  errorCode: TranscriptionJobErrorCode | null
  errorMessage: string | null
  webhookUrl: string | null
  cancelRequested: boolean
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}

export type TranscriptionChunkRecord = {
  jobPublicId: string
  chunkIndex: number
  startSeconds: number
  endSeconds: number
  status: 'completed' | 'failed'
  text: string | null
  segmentsJson: TranscriptionResultSegment[] | null
  processingSeconds: number | null
  errorMessage: string | null
}

export type TranscriptionJobErrorCode =
  (typeof TRANSCRIPTION_JOB_ERROR_CODES)[number]

export type CreateTranscriptionJobInput = {
  apiTokenId: number
  level: TranscriptionLevel
  language: TranscriptionLanguage
  originalFilename: string
  inputPath: string
  webhookUrl: string | null
}

export type TranscriptionJobUpdate = Partial<
  Pick<
    TranscriptionJobRecord,
    | 'status'
    | 'detectedLanguage'
    | 'model'
    | 'normalizedAudioPath'
    | 'mediaCleanupStatus'
    | 'resultJson'
    | 'progress'
    | 'currentChunk'
    | 'totalChunks'
    | 'durationSeconds'
    | 'processingSeconds'
    | 'errorCode'
    | 'errorMessage'
    | 'cancelRequested'
    | 'startedAt'
    | 'completedAt'
  >
>

export type TranscriptionJobStore = {
  create(input: CreateTranscriptionJobInput): Promise<TranscriptionJobRecord>
  listForToken(apiTokenId: number): Promise<TranscriptionJobRecord[]>
  findByPublicId(publicId: string): Promise<TranscriptionJobRecord | null>
  findByPublicIdForToken(publicId: string, apiTokenId: number): Promise<TranscriptionJobRecord | null>
  update(publicId: string, update: TranscriptionJobUpdate): Promise<TranscriptionJobRecord>
  insertChunk(chunk: TranscriptionChunkRecord): Promise<void>
  listChunks(publicId: string): Promise<TranscriptionChunkRecord[]>
}

export type TranscriptionWorker = {
  enqueue(publicId: string): void
}

export type TranscriptionWebhookFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>

export type TranscriptionWebhookDispatcher = {
  deliver(job: TranscriptionJobRecord): Promise<void>
}

export type TranscriptionRouteOptions = {
  whisperUrl?: string
  whisperFetch?: TranscriptionFetch
  jobStore?: TranscriptionJobStore
  worker?: TranscriptionWorker | null
  mediaProcessor?: TranscriptionMediaProcessor
  durationProbe?: TranscriptionDurationProbe
  webhookFetch?: TranscriptionWebhookFetch
  webhookSecret?: string
  webhookMaxAttempts?: number
  webhookRetryBaseDelayMs?: number
  webhookDispatcher?: TranscriptionWebhookDispatcher
  uploadDir?: string
  keepMedia?: boolean
  syncMaxUploadBytes?: number
  syncMaxDurationSeconds?: number
  asyncMaxUploadBytes?: number
  asyncMaxDurationSeconds?: number
}

function normalizeLevel(value: FormDataEntryValue | null): TranscriptionLevel | null {
  if (value === null || value === '') return DEFAULT_TRANSCRIPTION_LEVEL
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return TRANSCRIPTION_LEVELS.includes(normalized as TranscriptionLevel) ? (normalized as TranscriptionLevel) : null
}

function normalizeLanguage(value: FormDataEntryValue | null): TranscriptionLanguage | null {
  if (value === null || value === '') return 'auto'
  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  if (normalized === 'auto') return 'auto'
  if (normalized === 'english') return 'en'
  if (normalized === 'german' || normalized === 'deutsch') return 'de'
  if (TRANSCRIPTION_LANGUAGE_HINTS.includes(normalized as TranscriptionLanguage)) return normalized as TranscriptionLanguage
  return null
}

function normalizeWebhookUrl(value: FormDataEntryValue | null): string | null | false {
  if (value === null || value === '') return null
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : false
  } catch {
    return false
  }
}

function fileExtension(filename: string) {
  return extname(filename).replace('.', '').toLowerCase()
}

function isSupportedMedia(filename: string) {
  return SUPPORTED_MEDIA_EXTENSIONS.has(fileExtension(filename))
}

function safeFilename(filename: string) {
  const cleaned = basename(filename || 'media').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128)
  return cleaned || 'media'
}

function createPublicJobId() {
  return `tr_${randomBytes(16).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`
}

function now() {
  return new Date()
}

async function writeTempUpload(file: File) {
  const dir = await mkdtemp(join(tmpdir(), 'girke-sync-transcription-'))
  const path = join(dir, safeFilename(file.name))
  await writeFile(path, Buffer.from(await file.arrayBuffer()))
  return { dir, path }
}

function jobUrls(publicId: string) {
  return {
    status_url: `/api/v1/transcription/jobs/${publicId}`,
    result_url: `/api/v1/transcription/jobs/${publicId}/result`
  }
}

type TranscriptionJobSummaryResponse = z.infer<typeof transcriptionJobSummarySchema>
type TranscriptionJobListResponse = z.infer<typeof transcriptionJobListResponseSchema>
type TranscriptionJobCreateAcceptedResponse = z.infer<typeof transcriptionJobCreateAcceptedResponseSchema>
type TranscriptionJobStatusResponse = z.infer<typeof transcriptionJobStatusResponseSchema>
type TranscriptionJobCancellationResponse = z.infer<typeof transcriptionJobCancellationResponseSchema>
type TranscriptionJobResultResponse = z.infer<typeof transcriptionJobResultResponseSchema>

function normalizeMultipartField<T>(value: unknown, normalize: (value: FormDataEntryValue | null) => T | null) {
  const normalized = normalize((value as FormDataEntryValue | undefined) ?? null)
  return normalized === null ? value : normalized
}

function normalizeMultipartWebhookUrlField(value: unknown) {
  const normalized = normalizeWebhookUrl((value as FormDataEntryValue | undefined) ?? null)
  if (normalized === null) return undefined
  return normalized === false ? value : normalized
}

function createWhisperTranscriptionFormData(file: File, level: TranscriptionLevel, language: TranscriptionLanguage) {
  const form = new FormData()
  form.set('file', file, file.name)
  form.set('level', level)
  if (language !== 'auto') {
    form.set('language', language)
  }
  return form
}

function createLiteralErrorSchema<Code extends string>(name: string, error: Code) {
  return z
    .object({
      error: z.literal(error).openapi({ example: error })
    })
    .openapi(name)
}

function getMultipartFieldErrorBody<FieldName extends string, ResponseBody>(
  issues: z.ZodIssue[],
  fieldOrder: readonly FieldName[],
  bodies: Record<FieldName, ResponseBody>
) {
  const fieldErrors = new Set(issues.map((issue) => String(issue.path[0] ?? '')))

  for (const field of fieldOrder) {
    if (fieldErrors.has(field)) {
      return bodies[field]
    }
  }

  return bodies[fieldOrder[0]]
}

function createTranscriptionSyncUploadTooLargeBody(maxBytes: number) {
  return {
    error: 'sync_upload_too_large' as const,
    max_bytes: maxBytes,
    jobs_url: transcriptionJobsPath
  }
}

function createTranscriptionSyncMediaTooLongBody(maxDurationSeconds: number) {
  return {
    error: 'sync_media_too_long' as const,
    max_duration_seconds: maxDurationSeconds,
    jobs_url: transcriptionJobsPath
  }
}

function serializeTerminalJobError(status: 'failed' | 'cancelled', errorCode: TranscriptionJobErrorCode | null, errorMessage: string | null) {
  if (status === 'cancelled') {
    return {
      code: errorCode ?? 'JOB_CANCELLED',
      message: errorMessage ?? 'Job cancelled'
    }
  }

  return {
    code: errorCode ?? 'TRANSCRIPTION_WORKER_FAILED',
    message: errorMessage ?? 'Transcription job failed'
  }
}

function serializeJobSummary(job: TranscriptionJobRecord): TranscriptionJobSummaryResponse {
  const body: TranscriptionJobSummaryResponse = {
    job_id: job.publicId,
    status: job.status,
    progress: job.progress,
    level: job.level,
    language: job.language,
    detected_language: job.detectedLanguage,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString()
  }

  if (job.currentChunk !== null) body.current_chunk = job.currentChunk
  if (job.totalChunks !== null) body.total_chunks = job.totalChunks
  if (job.durationSeconds !== null) body.duration_seconds = job.durationSeconds
  if (job.processingSeconds !== null) body.processing_seconds = job.processingSeconds
  if (job.status === 'processing' && job.startedAt) {
    body.processing_seconds_elapsed = Math.max(0, (Date.now() - job.startedAt.getTime()) / 1000)
  }
  if (job.model) body.model = job.model
  if (job.startedAt) body.started_at = job.startedAt.toISOString()
  if (job.completedAt) body.completed_at = job.completedAt.toISOString()
  if (job.status === 'completed') body.result_url = jobUrls(job.publicId).result_url
  if (job.status === 'failed' || job.status === 'cancelled') {
    body.error = serializeTerminalJobError(job.status, job.errorCode, job.errorMessage)
  }

  return body
}

function serializeCreatedJob(job: TranscriptionJobRecord): TranscriptionJobCreateAcceptedResponse {
  return {
    job_id: job.publicId,
    status: 'queued',
    level: job.level,
    language: job.language,
    detected_language: null,
    created_at: job.createdAt.toISOString(),
    ...jobUrls(job.publicId)
  }
}

function serializeJobStatus(job: TranscriptionJobRecord): TranscriptionJobStatusResponse {
  return transcriptionJobStatusResponseSchema.parse(serializeJobSummary(job))
}

function serializeCancelledJob(job: TranscriptionJobRecord): TranscriptionJobCancellationResponse {
  return transcriptionJobCancellationResponseSchema.parse(serializeJobSummary(job))
}

function serializeCompletedResult(job: TranscriptionJobRecord): TranscriptionJobResultResponse | null {
  if (job.status !== 'completed' || !job.resultJson) return null
  return transcriptionJobResultResponseSchema.parse({
    job_id: job.publicId,
    status: 'completed',
    ...job.resultJson
  })
}

function webhookEvent(job: TranscriptionJobRecord) {
  return `transcription.job.${job.status}`
}

export function createTranscriptionWebhookDispatcher(opts: {
  webhookFetch?: TranscriptionWebhookFetch
  webhookSecret?: string
  maxAttempts?: number
  retryBaseDelayMs?: number
} = {}): TranscriptionWebhookDispatcher {
  const webhookFetch = opts.webhookFetch ?? fetch
  const maxAttempts = opts.maxAttempts ?? 5
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? 500

  return {
    async deliver(job) {
      if (!job.webhookUrl || !['completed', 'failed', 'cancelled'].includes(job.status)) return

      const payload = {
        event: webhookEvent(job),
        job: serializeJobSummary(job)
      }
      const body = JSON.stringify(payload)
      const headers = new Headers({ 'content-type': 'application/json' })
      if (opts.webhookSecret) {
        headers.set('x-girke-signature', `sha256=${createHmac('sha256', opts.webhookSecret).update(body).digest('hex')}`)
      }

      let lastError = ''
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await webhookFetch(job.webhookUrl, {
            method: 'POST',
            headers,
            body
          })
          if (response.ok) return
          lastError = `status ${response.status}`
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }

        if (attempt < maxAttempts && retryBaseDelayMs > 0) {
          await sleep(retryBaseDelayMs * 2 ** (attempt - 1))
        }
      }

      console.error(JSON.stringify({ level: 'error', msg: 'webhook_delivery_failed', job_id: job.publicId, error: lastError }))
    }
  }
}

export class InMemoryTranscriptionJobStore implements TranscriptionJobStore {
  private jobs = new Map<string, TranscriptionJobRecord>()
  private chunks: TranscriptionChunkRecord[] = []

  async create(input: CreateTranscriptionJobInput) {
    const date = now()
    const job: TranscriptionJobRecord = {
      publicId: createPublicJobId(),
      apiTokenId: input.apiTokenId,
      status: 'queued',
      level: input.level,
      language: input.language,
      detectedLanguage: null,
      model: null,
      originalFilename: input.originalFilename,
      inputPath: input.inputPath,
      normalizedAudioPath: null,
      mediaCleanupStatus: 'pending',
      resultJson: null,
      progress: 0,
      currentChunk: null,
      totalChunks: null,
      durationSeconds: null,
      processingSeconds: null,
      errorCode: null,
      errorMessage: null,
      webhookUrl: input.webhookUrl,
      cancelRequested: false,
      createdAt: date,
      startedAt: null,
      completedAt: null,
      updatedAt: date
    }
    this.jobs.set(job.publicId, job)
    return job
  }

  async listForToken(apiTokenId: number) {
    return [...this.jobs.values()].filter((job) => job.apiTokenId === apiTokenId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  async findByPublicId(publicId: string) {
    return this.jobs.get(publicId) ?? null
  }

  async findByPublicIdForToken(publicId: string, apiTokenId: number) {
    const job = await this.findByPublicId(publicId)
    return job?.apiTokenId === apiTokenId ? job : null
  }

  async update(publicId: string, update: TranscriptionJobUpdate) {
    const existing = this.jobs.get(publicId)
    if (!existing) throw new Error(`transcription job not found: ${publicId}`)
    const updated = { ...existing, ...update, updatedAt: now() }
    this.jobs.set(publicId, updated)
    return updated
  }

  async insertChunk(chunk: TranscriptionChunkRecord) {
    this.chunks.push(chunk)
  }

  async listChunks(publicId: string) {
    return this.chunks.filter((chunk) => chunk.jobPublicId === publicId).sort((a, b) => a.chunkIndex - b.chunkIndex)
  }
}

export class InProcessTranscriptionWorker implements TranscriptionWorker {
  private queue = Promise.resolve()

  constructor(
    private readonly opts: {
      store: TranscriptionJobStore
      whisperUrl: string
      whisperFetch: TranscriptionFetch
      mediaProcessor: TranscriptionMediaProcessor
      keepMedia: boolean
      asyncMaxDurationSeconds: number
      webhookDispatcher?: TranscriptionWebhookDispatcher
    }
  ) {}

  enqueue(publicId: string) {
    this.queue = this.queue.then(() => this.process(publicId)).catch((err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'transcription worker queue failed', error: err instanceof Error ? err.message : String(err) }))
    })
  }

  private async process(publicId: string) {
    const job = await this.opts.store.findByPublicId(publicId)
    if (!job || (job.status !== 'queued' && job.status !== 'processing') || job.cancelRequested) return

    await this.opts.store.update(publicId, {
      status: 'processing',
      ...(job.status === 'queued' ? { progress: 0, currentChunk: 0 } : {}),
      ...(job.startedAt ? {} : { startedAt: now() })
    })

    const started = Date.now()
    let prepared: PreparedTranscriptionMedia | null = null

    try {
      prepared = await this.opts.mediaProcessor.prepare(job.inputPath)
      if (prepared.durationSeconds > this.opts.asyncMaxDurationSeconds) {
        await this.fail(publicId, 'MEDIA_DURATION_EXCEEDED', `Media duration exceeds ${this.opts.asyncMaxDurationSeconds} seconds`)
        await this.cleanupMedia(publicId, job.inputPath, prepared)
        return
      }

      await this.opts.store.update(publicId, {
        normalizedAudioPath: prepared.normalizedAudioPath,
        durationSeconds: prepared.durationSeconds,
        totalChunks: prepared.chunks.length
      })

      const completedChunks = new Map(
        (await this.opts.store.listChunks(publicId))
          .filter((chunk) => chunk.status === 'completed' && chunk.text !== null && chunk.segmentsJson !== null)
          .map((chunk) => [chunk.chunkIndex, chunk])
      )

      for (const chunk of prepared.chunks) {
        const existing = completedChunks.get(chunk.chunkIndex)
        if (existing) {
          await this.opts.store.update(publicId, {
            currentChunk: chunk.chunkIndex + 1,
            progress: this.processingProgress(completedChunks.size, prepared.chunks.length)
          })
          continue
        }

        await this.opts.store.update(publicId, {
          currentChunk: chunk.chunkIndex,
          progress: this.processingProgress(completedChunks.size, prepared.chunks.length)
        })

        const file = new File([await readFile(chunk.path)], basename(chunk.path))
        try {
          const result = await this.transcribeChunkWithRetry(file, job.level, job.language)
          const segments = result.segments.map((segment) => ({
            start: chunk.startSeconds + segment.start,
            end: chunk.startSeconds + segment.end,
            text: segment.text,
            chunk_index: chunk.chunkIndex
          }))
          const storedChunk: TranscriptionChunkRecord = {
            jobPublicId: publicId,
            chunkIndex: chunk.chunkIndex,
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            status: 'completed',
            text: result.text,
            segmentsJson: segments,
            processingSeconds: result.processing_seconds,
            errorMessage: null
          }
          await this.opts.store.insertChunk(storedChunk)
          completedChunks.set(chunk.chunkIndex, storedChunk)
          await this.opts.store.update(publicId, {
            currentChunk: chunk.chunkIndex + 1,
            progress: this.processingProgress(completedChunks.size, prepared.chunks.length),
            detectedLanguage: result.detected_language,
            model: result.model
          })
        } catch (err) {
          const code = err instanceof TranscriptionWorkerError ? err.code : 'TRANSCRIPTION_WORKER_FAILED'
          await this.fail(publicId, code, err instanceof Error ? err.message : 'Transcription worker failed', chunk)
          await this.cleanupMedia(publicId, job.inputPath, prepared)
          return
        }

        const latest = await this.opts.store.findByPublicId(publicId)
        if (!latest || latest.status === 'cancelled' || latest.cancelRequested) {
          await this.cleanupMedia(publicId, job.inputPath, prepared)
          return
        }
      }

      const finalChunks = [...completedChunks.values()].sort((a, b) => a.chunkIndex - b.chunkIndex)
      const stitched = this.stitchChunks(finalChunks)
      const processingSeconds = finalChunks.reduce((total, chunk) => total + (chunk.processingSeconds ?? 0), 0) || (Date.now() - started) / 1000
      const latest = await this.opts.store.findByPublicId(publicId)
      await this.cleanupMedia(publicId, job.inputPath, prepared)
      const completed = await this.opts.store.update(publicId, {
        status: 'completed',
        progress: 1,
        currentChunk: prepared.chunks.length,
        totalChunks: prepared.chunks.length,
        durationSeconds: prepared.durationSeconds,
        processingSeconds,
        detectedLanguage: latest?.detectedLanguage ?? null,
        model: latest?.model ?? null,
        resultJson: {
          text: stitched.text,
          segments: stitched.segments,
          duration_seconds: prepared.durationSeconds,
          processing_seconds: processingSeconds,
          level: job.level,
          language: job.language,
          detected_language: latest?.detectedLanguage ?? null,
          model: latest?.model ?? ''
        },
        completedAt: now()
      })
      await this.opts.webhookDispatcher?.deliver(completed)
    } catch (err) {
      const latest = await this.opts.store.findByPublicId(publicId)
      if (latest?.status === 'cancelled' || latest?.cancelRequested) {
        await this.cleanupMedia(publicId, job.inputPath, prepared)
        return
      }

      const code =
        err instanceof TranscriptionWorkerError
          ? err.code
          : err instanceof TranscriptionMediaProcessorError
            ? err.code
            : 'TRANSCRIPTION_WORKER_FAILED'
      await this.fail(publicId, code, err instanceof Error ? err.message : 'Transcription worker failed')
      await this.cleanupMedia(publicId, job.inputPath, prepared)
    }
  }

  private processingProgress(completedChunks: number, totalChunks: number) {
    if (totalChunks <= 0) return 0
    return Math.min(completedChunks / totalChunks, 0.999)
  }

  private stitchChunks(chunks: TranscriptionChunkRecord[]) {
    const segments: TranscriptionResultSegment[] = []
    let lastEnd = 0
    for (const chunk of chunks) {
      for (const segment of chunk.segmentsJson ?? []) {
        if (segment.end <= lastEnd) continue
        const stitched = {
          ...segment,
          start: Math.max(segment.start, lastEnd)
        }
        segments.push(stitched)
        lastEnd = Math.max(lastEnd, stitched.end)
      }
    }

    return {
      text: segments.map((segment) => segment.text.trim()).filter(Boolean).join(' '),
      segments
    }
  }

  private async transcribeFile(file: File, level: TranscriptionLevel, language: TranscriptionLanguage): Promise<WhisperTranscriptionResponse> {
    const response = await this.opts.whisperFetch(`${this.opts.whisperUrl}/transcribe`, {
      method: 'POST',
      body: createWhisperTranscriptionFormData(file, level, language)
    })

    if (!response.ok) {
      if (response.status === 415) throw new TranscriptionWorkerError('UNSUPPORTED_MEDIA_FORMAT', 'Unsupported media format')
      if (response.status === 422) throw new TranscriptionWorkerError('MEDIA_NORMALIZATION_FAILED', 'Media normalization failed')
      throw new TranscriptionWorkerError('TRANSCRIPTION_WORKER_FAILED', `Whisper failed with status ${response.status}`)
    }

    return whisperTranscriptionResponseSchema.parse(await response.json())
  }

  private async transcribeChunkWithRetry(file: File, level: TranscriptionLevel, language: TranscriptionLanguage) {
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.transcribeFile(file, level, language)
      } catch (err) {
        lastError = err
        if (err instanceof TranscriptionWorkerError && (err.code === 'UNSUPPORTED_MEDIA_FORMAT' || err.code === 'MEDIA_NORMALIZATION_FAILED')) {
          throw err
        }
      }
    }

    throw new TranscriptionWorkerError('CHUNK_RETRY_EXHAUSTED', lastError instanceof Error ? lastError.message : 'Chunk retry exhausted')
  }

  private async fail(publicId: string, code: TranscriptionJobErrorCode, message: string, chunk?: TranscriptionMediaChunk) {
    await this.opts.store.insertChunk({
      jobPublicId: publicId,
      chunkIndex: chunk?.chunkIndex ?? 0,
      startSeconds: chunk?.startSeconds ?? 0,
      endSeconds: chunk?.endSeconds ?? 0,
      status: 'failed',
      text: null,
      segmentsJson: null,
      processingSeconds: null,
      errorMessage: message
    })
    const failed = await this.opts.store.update(publicId, {
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      completedAt: now()
    })
    await this.opts.webhookDispatcher?.deliver(failed)
  }

  private async cleanupMedia(publicId: string, inputPath: string, prepared?: PreparedTranscriptionMedia | null) {
    if (this.opts.keepMedia) {
      await this.opts.store.update(publicId, { mediaCleanupStatus: 'kept' })
      return
    }

    try {
      await rm(inputPath, { force: true })
      if (prepared) {
        await rm(prepared.normalizedAudioPath, { force: true })
        await Promise.all(prepared.chunks.map((chunk) => rm(chunk.path, { force: true })))
        await rm(`${inputPath}.work`, { recursive: true, force: true })
      }
      await this.opts.store.update(publicId, { mediaCleanupStatus: 'deleted' })
    } catch {
      await this.opts.store.update(publicId, { mediaCleanupStatus: 'failed' })
    }
  }
}

const transcriptionJobIdExample = 'tr_01jzexample'
const transcriptionJobStatusUrlExample = `/api/v1/transcription/jobs/${transcriptionJobIdExample}`
const transcriptionJobResultUrlExample = `/api/v1/transcription/jobs/${transcriptionJobIdExample}/result`
const transcriptionDateTimeExample = '2026-07-11T00:00:00.000Z'

const transcriptionJobDateTimeSchema = z.string().datetime({ offset: true })

const transcriptionJobErrorSchema = z
  .object({
    code: z
      .enum(TRANSCRIPTION_JOB_ERROR_CODES)
      .openapi({ example: 'TRANSCRIPTION_WORKER_FAILED', description: 'Stable Transcription Job failure code.' }),
    message: z.string().openapi({ example: 'Transcription job failed', description: 'Human-readable Transcription Job failure message.' })
  })
  .openapi('TranscriptionJobError')

const transcriptionJobSummaryExample = {
  job_id: transcriptionJobIdExample,
  status: 'queued',
  progress: 0,
  level: 'high',
  language: 'en',
  detected_language: null,
  created_at: transcriptionDateTimeExample,
  updated_at: transcriptionDateTimeExample
} as const

const transcriptionJobSummarySchema = z
  .object({
    job_id: z.string().openapi({ example: transcriptionJobSummaryExample.job_id, description: 'Public Transcription Job identifier.' }),
    status: z.enum(TRANSCRIPTION_JOB_STATUSES).openapi({ example: transcriptionJobSummaryExample.status, description: 'Current Transcription Job status.' }),
    progress: z.number().min(0).max(1).openapi({ example: transcriptionJobSummaryExample.progress, description: 'Job completion progress from 0 to 1.' }),
    level: z.enum(TRANSCRIPTION_LEVELS).openapi({ example: transcriptionJobSummaryExample.level, description: 'Requested transcription level for the job.' }),
    language: z
      .enum(TRANSCRIPTION_LANGUAGE_HINTS)
      .openapi({ example: transcriptionJobSummaryExample.language, description: 'Requested Language Hint for the job.' }),
    detected_language: z
      .string()
      .nullable()
      .openapi({ example: transcriptionJobSummaryExample.detected_language, description: 'Detected Language from processed media, if available.' }),
    created_at: transcriptionJobDateTimeSchema.openapi({
      example: transcriptionJobSummaryExample.created_at,
      description: 'When the Transcription Job was created.'
    }),
    updated_at: transcriptionJobDateTimeSchema.openapi({
      example: transcriptionJobSummaryExample.updated_at,
      description: 'When the Transcription Job record last changed.'
    }),
    current_chunk: z.number().int().nonnegative().optional().openapi({ example: 14, description: 'Current zero-based chunk index while processing.' }),
    total_chunks: z.number().int().positive().optional().openapi({ example: 33, description: 'Total number of normalized chunks for the job.' }),
    duration_seconds: z.number().nonnegative().optional().openapi({ example: 1980.5, description: 'Media duration in seconds when known.' }),
    processing_seconds: z
      .number()
      .nonnegative()
      .optional()
      .openapi({ example: 3637.2, description: 'Total transcription processing time in seconds for completed jobs.' }),
    processing_seconds_elapsed: z
      .number()
      .nonnegative()
      .optional()
      .openapi({ example: 732.1, description: 'Elapsed processing time in seconds for in-progress jobs.' }),
    model: z.string().optional().openapi({ example: 'large-v3-turbo', description: 'Transcription model used for the job when known.' }),
    started_at: transcriptionJobDateTimeSchema.optional().openapi({
      example: '2026-07-11T00:01:00.000Z',
      description: 'When processing started.'
    }),
    completed_at: transcriptionJobDateTimeSchema.optional().openapi({
      example: '2026-07-11T01:01:37.000Z',
      description: 'When the job reached a terminal state.'
    }),
    result_url: z
      .string()
      .optional()
      .openapi({ example: transcriptionJobResultUrlExample, description: 'Relative URL for fetching the completed Job Result.' }),
    error: transcriptionJobErrorSchema.optional().openapi({ description: 'Terminal failure or cancellation details when present.' })
  })
  .openapi('TranscriptionJobSummary', {
    description: 'Authenticated Transcription Job summary. Listing returns only jobs owned by the calling API Token.'
  })

const transcriptionJobListResponseExample = {
  jobs: [transcriptionJobSummaryExample]
} as const

const transcriptionJobListResponseSchema = z
  .object({
    jobs: z.array(transcriptionJobSummarySchema).openapi({
      example: transcriptionJobListResponseExample.jobs,
      description: 'Transcription Jobs owned by the authenticated API Token.'
    })
  })
  .openapi('TranscriptionJobListResponse')

const transcriptionJobCreateAcceptedResponseExample = {
  job_id: transcriptionJobIdExample,
  status: 'queued',
  level: 'high',
  language: 'en',
  detected_language: null,
  created_at: transcriptionDateTimeExample,
  status_url: transcriptionJobStatusUrlExample,
  result_url: transcriptionJobResultUrlExample
} as const

const transcriptionJobCreateAcceptedResponseSchema = z
  .object({
    job_id: z.string().openapi({ example: transcriptionJobCreateAcceptedResponseExample.job_id, description: 'Public Transcription Job identifier.' }),
    status: z.literal('queued').openapi({ example: transcriptionJobCreateAcceptedResponseExample.status, description: 'Initial queued Transcription Job status.' }),
    level: z
      .enum(TRANSCRIPTION_LEVELS)
      .openapi({ example: transcriptionJobCreateAcceptedResponseExample.level, description: 'Normalized transcription level stored on the job.' }),
    language: z
      .enum(TRANSCRIPTION_LANGUAGE_HINTS)
      .openapi({ example: transcriptionJobCreateAcceptedResponseExample.language, description: 'Normalized Language Hint stored on the job.' }),
    detected_language: z
      .null()
      .openapi({ example: transcriptionJobCreateAcceptedResponseExample.detected_language, description: 'Detected Language is not known at creation time.' }),
    created_at: transcriptionJobDateTimeSchema.openapi({
      example: transcriptionJobCreateAcceptedResponseExample.created_at,
      description: 'When the Transcription Job was created.'
    }),
    status_url: z
      .string()
      .openapi({ example: transcriptionJobCreateAcceptedResponseExample.status_url, description: 'Relative URL for polling Transcription Job status.' }),
    result_url: z
      .string()
      .openapi({ example: transcriptionJobCreateAcceptedResponseExample.result_url, description: 'Relative URL for fetching the Job Result later.' })
  })
  .openapi('TranscriptionJobCreateAcceptedResponse')

const transcriptionJobCreateFileRequiredErrorSchema = createLiteralErrorSchema(
  'TranscriptionJobCreateFileRequiredErrorResponse',
  'file_required'
)

const transcriptionJobCreateInvalidLevelErrorSchema = createLiteralErrorSchema(
  'TranscriptionJobCreateInvalidLevelErrorResponse',
  'invalid_level'
)

const transcriptionJobCreateInvalidLanguageErrorSchema = createLiteralErrorSchema(
  'TranscriptionJobCreateInvalidLanguageErrorResponse',
  'invalid_language'
)

const transcriptionJobCreateInvalidWebhookUrlErrorSchema = createLiteralErrorSchema(
  'TranscriptionJobCreateInvalidWebhookUrlErrorResponse',
  'invalid_webhook_url'
)

const transcriptionJobCreateBadRequestResponseSchema = z
  .union([
    transcriptionJobCreateFileRequiredErrorSchema,
    transcriptionJobCreateInvalidLevelErrorSchema,
    transcriptionJobCreateInvalidLanguageErrorSchema,
    transcriptionJobCreateInvalidWebhookUrlErrorSchema
  ])
  .openapi('TranscriptionJobCreateBadRequestResponse')

const transcriptionJobCreateUploadTooLargeExample = {
  error: 'upload_too_large',
  max_bytes: DEFAULT_ASYNC_MAX_UPLOAD_BYTES
} as const

const transcriptionJobCreateUploadTooLargeResponseSchema = z
  .object({
    error: z.literal('upload_too_large').openapi({ example: transcriptionJobCreateUploadTooLargeExample.error }),
    max_bytes: z.number().int().positive().openapi({
      example: transcriptionJobCreateUploadTooLargeExample.max_bytes,
      description: 'Maximum accepted async upload size in bytes.'
    })
  })
  .openapi('TranscriptionJobCreateUploadTooLargeResponse')

const transcriptionJobCreateUnsupportedMediaResponseSchema = createLiteralErrorSchema(
  'TranscriptionJobCreateUnsupportedMediaResponse',
  'unsupported_media_format'
)

const transcriptionJobCreateMediaDurationExceededExample = {
  error: 'media_duration_exceeded',
  max_duration_seconds: DEFAULT_ASYNC_MAX_DURATION_SECONDS
} as const

const transcriptionJobCreateMediaDurationExceededResponseSchema = z
  .object({
    error: z.literal('media_duration_exceeded').openapi({ example: transcriptionJobCreateMediaDurationExceededExample.error }),
    max_duration_seconds: z.number().positive().openapi({
      example: transcriptionJobCreateMediaDurationExceededExample.max_duration_seconds,
      description: 'Maximum accepted async media duration in seconds.'
    })
  })
  .openapi('TranscriptionJobCreateMediaDurationExceededResponse')

const transcriptionInternalServerErrorExample = { error: 'internal_server_error' } as const

const transcriptionInternalServerErrorResponseSchema = createLiteralErrorSchema('InternalServerErrorResponse', 'internal_server_error')

const transcriptionSyncFileRequiredErrorSchema = createLiteralErrorSchema(
  'TranscriptionSyncFileRequiredErrorResponse',
  'file_required'
)

const transcriptionSyncInvalidLevelErrorSchema = createLiteralErrorSchema(
  'TranscriptionSyncInvalidLevelErrorResponse',
  'invalid_level'
)

const transcriptionSyncInvalidLanguageErrorSchema = createLiteralErrorSchema(
  'TranscriptionSyncInvalidLanguageErrorResponse',
  'invalid_language'
)

const transcriptionSyncBadRequestResponseSchema = z
  .union([
    transcriptionSyncFileRequiredErrorSchema,
    transcriptionSyncInvalidLevelErrorSchema,
    transcriptionSyncInvalidLanguageErrorSchema
  ])
  .openapi('TranscriptionSyncBadRequestResponse')

const transcriptionSyncUploadTooLargeExample = {
  error: 'sync_upload_too_large',
  max_bytes: DEFAULT_SYNC_MAX_UPLOAD_BYTES,
  jobs_url: transcriptionJobsPath
} as const

const transcriptionSyncUploadTooLargeResponseSchema = z
  .object({
    error: z.literal('sync_upload_too_large').openapi({ example: transcriptionSyncUploadTooLargeExample.error }),
    max_bytes: z.number().int().positive().openapi({
      example: transcriptionSyncUploadTooLargeExample.max_bytes,
      description: 'Maximum accepted synchronous upload size in bytes.'
    }),
    jobs_url: z.string().openapi({
      example: transcriptionSyncUploadTooLargeExample.jobs_url,
      description: 'Relative URL for creating an async Transcription Job instead.'
    })
  })
  .openapi('TranscriptionSyncUploadTooLargeResponse')

const transcriptionSyncUnsupportedMediaResponseSchema = createLiteralErrorSchema(
  'TranscriptionSyncUnsupportedMediaResponse',
  'unsupported_media_format'
)

const transcriptionSyncMediaNormalizationFailedResponseSchema = createLiteralErrorSchema(
  'TranscriptionSyncMediaNormalizationFailedResponse',
  'media_normalization_failed'
)

const transcriptionSyncMediaTooLongExample = {
  error: 'sync_media_too_long',
  max_duration_seconds: DEFAULT_SYNC_MAX_DURATION_SECONDS,
  jobs_url: transcriptionJobsPath
} as const

const transcriptionSyncMediaTooLongResponseSchema = z
  .object({
    error: z.literal('sync_media_too_long').openapi({ example: transcriptionSyncMediaTooLongExample.error }),
    max_duration_seconds: z.number().positive().openapi({
      example: transcriptionSyncMediaTooLongExample.max_duration_seconds,
      description: 'Maximum accepted synchronous media duration in seconds.'
    }),
    jobs_url: z.string().openapi({
      example: transcriptionSyncMediaTooLongExample.jobs_url,
      description: 'Relative URL for creating an async Transcription Job instead.'
    })
  })
  .openapi('TranscriptionSyncMediaTooLongResponse')

const transcriptionSyncUnprocessableEntityResponseSchema = z
  .union([
    transcriptionSyncMediaNormalizationFailedResponseSchema,
    transcriptionSyncMediaTooLongResponseSchema
  ])
  .openapi('TranscriptionSyncUnprocessableEntityResponse')

const transcriptionSyncWhisperFailedResponseSchema = createLiteralErrorSchema(
  'TranscriptionSyncWhisperFailedResponse',
  'whisper_failed'
)

const transcriptionSyncLevelFieldSchema = z
  .preprocess(
    (value) => normalizeMultipartField(value, normalizeLevel),
    z.enum(TRANSCRIPTION_LEVELS).optional()
  )
  .transform((value) => value ?? DEFAULT_TRANSCRIPTION_LEVEL)
  .openapi({
    type: 'string',
    enum: [...TRANSCRIPTION_LEVELS],
    example: 'high',
    description: 'Optional transcription level for short synchronous transcription. Omitted values default to medium.'
  })

const transcriptionSyncLanguageFieldSchema = z
  .preprocess(
    (value) => normalizeMultipartField(value, normalizeLanguage),
    z.enum(TRANSCRIPTION_LANGUAGE_HINTS).optional()
  )
  .transform((value) => value ?? 'auto')
  .openapi({
    type: 'string',
    enum: [...TRANSCRIPTION_LANGUAGE_HINTS],
    example: 'en',
    description:
      'Optional Language Hint for short synchronous transcription. Accepted aliases normalize to supported values and omitted values default to auto detection.'
  })

const transcriptionSyncRequestSchema = z
  .object({
    file: z.file().openapi({
      type: 'string',
      format: 'binary',
      description: 'Audio or video file uploaded for short synchronous transcription.'
    }),
    level: transcriptionSyncLevelFieldSchema,
    language: transcriptionSyncLanguageFieldSchema
  })
  .openapi('TranscriptionSyncRequest', {
    description: 'Multipart synchronous transcription fields for short clips.'
  })

type TranscriptionSyncBadRequestResponse = z.infer<typeof transcriptionSyncBadRequestResponseSchema>

const transcriptionSyncBadRequestBodies = {
  file: { error: 'file_required' },
  level: { error: 'invalid_level' },
  language: { error: 'invalid_language' }
} as const satisfies Record<string, TranscriptionSyncBadRequestResponse>

const transcriptionSyncBadRequestFieldOrder = ['file', 'level', 'language'] as const

function getTranscriptionSyncBadRequestBody(issues: z.ZodIssue[]): TranscriptionSyncBadRequestResponse {
  return getMultipartFieldErrorBody(issues, transcriptionSyncBadRequestFieldOrder, transcriptionSyncBadRequestBodies)
}

const transcriptionJobCreateLevelFieldSchema = z
  .preprocess(
    (value) => normalizeMultipartField(value, normalizeLevel),
    z.enum(TRANSCRIPTION_LEVELS).optional()
  )
  .transform((value) => value ?? DEFAULT_TRANSCRIPTION_LEVEL)
  .openapi({
    type: 'string',
    enum: [...TRANSCRIPTION_LEVELS],
    example: 'high',
    description: 'Optional transcription level. Aliases are normalized and omitted values default to medium.'
  })

const transcriptionJobCreateLanguageFieldSchema = z
  .preprocess(
    (value) => normalizeMultipartField(value, normalizeLanguage),
    z.enum(TRANSCRIPTION_LANGUAGE_HINTS).optional()
  )
  .transform((value) => value ?? 'auto')
  .openapi({
    type: 'string',
    enum: [...TRANSCRIPTION_LANGUAGE_HINTS],
    example: 'en',
    description:
      'Optional Language Hint. Accepted aliases normalize to supported values and omitted values default to auto detection.'
  })

const transcriptionJobCreateWebhookUrlFieldSchema = z
  .preprocess(
    normalizeMultipartWebhookUrlField,
    z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === 'https:', { message: 'Webhook URL must use https.' })
      .optional()
  )
  .openapi({
    example: 'https://example.com/hooks/transcription',
    format: 'uri',
    description: 'Optional HTTPS webhook URL for terminal Transcription Job notifications.'
  })

const transcriptionJobCreateRequestSchema = z
  .object({
    file: z.file().openapi({
      type: 'string',
      format: 'binary',
      description: 'Audio or video file uploaded once for async transcription processing.'
    }),
    level: transcriptionJobCreateLevelFieldSchema,
    language: transcriptionJobCreateLanguageFieldSchema,
    webhook_url: transcriptionJobCreateWebhookUrlFieldSchema
  })
  .openapi('TranscriptionJobCreateRequest', {
    description: 'Multipart async Transcription Job creation fields.'
  })

type TranscriptionJobCreateBadRequestResponse = z.infer<typeof transcriptionJobCreateBadRequestResponseSchema>

const transcriptionJobCreateBadRequestBodies = {
  file: { error: 'file_required' },
  level: { error: 'invalid_level' },
  language: { error: 'invalid_language' },
  webhook_url: { error: 'invalid_webhook_url' }
} as const satisfies Record<string, TranscriptionJobCreateBadRequestResponse>

const transcriptionJobCreateBadRequestFieldOrder = ['file', 'level', 'language', 'webhook_url'] as const

function getTranscriptionJobCreateBadRequestBody(issues: z.ZodIssue[]): TranscriptionJobCreateBadRequestResponse {
  return getMultipartFieldErrorBody(issues, transcriptionJobCreateBadRequestFieldOrder, transcriptionJobCreateBadRequestBodies)
}

const transcriptionJobIdParamsSchema = z
  .object({
    job_id: z.string().openapi({
      param: {
        name: 'job_id',
        in: 'path'
      },
      example: transcriptionJobIdExample,
      description: 'Public Transcription Job identifier.'
    })
  })
  .openapi('TranscriptionJobParams')

const transcriptionJobStatusCommonSchema = transcriptionJobSummarySchema.pick({
  job_id: true,
  progress: true,
  level: true,
  language: true,
  detected_language: true,
  created_at: true,
  updated_at: true
})

const transcriptionJobProcessingExample = {
  job_id: transcriptionJobIdExample,
  status: 'processing',
  progress: 0.42,
  level: 'high',
  language: 'en',
  detected_language: 'en',
  created_at: transcriptionDateTimeExample,
  updated_at: '2026-07-11T00:06:00.000Z',
  current_chunk: 14,
  total_chunks: 33,
  duration_seconds: 1980.5,
  processing_seconds_elapsed: 732.1,
  model: 'large-v3-turbo',
  started_at: '2026-07-11T00:01:00.000Z'
} as const

const transcriptionJobCompletedExample = {
  job_id: transcriptionJobIdExample,
  status: 'completed',
  progress: 1,
  level: 'high',
  language: 'en',
  detected_language: 'en',
  created_at: transcriptionDateTimeExample,
  updated_at: '2026-07-11T01:01:37.000Z',
  current_chunk: 33,
  total_chunks: 33,
  duration_seconds: 1980.5,
  processing_seconds: 3637.2,
  model: 'large-v3-turbo',
  started_at: '2026-07-11T00:01:00.000Z',
  completed_at: '2026-07-11T01:01:37.000Z',
  result_url: transcriptionJobResultUrlExample
} as const

const transcriptionJobFailedExample = {
  job_id: transcriptionJobIdExample,
  status: 'failed',
  progress: 0.5,
  level: 'high',
  language: 'en',
  detected_language: 'en',
  created_at: transcriptionDateTimeExample,
  updated_at: '2026-07-11T00:26:00.000Z',
  current_chunk: 16,
  total_chunks: 33,
  duration_seconds: 1980.5,
  model: 'large-v3-turbo',
  started_at: '2026-07-11T00:01:00.000Z',
  completed_at: '2026-07-11T00:26:00.000Z',
  error: {
    code: 'CHUNK_RETRY_EXHAUSTED',
    message: 'Chunk retry exhausted'
  }
} as const

const transcriptionJobCancelledExample = {
  job_id: transcriptionJobIdExample,
  status: 'cancelled',
  progress: 0,
  level: 'high',
  language: 'en',
  detected_language: null,
  created_at: transcriptionDateTimeExample,
  updated_at: '2026-07-11T00:03:00.000Z',
  completed_at: '2026-07-11T00:03:00.000Z',
  error: {
    code: 'JOB_CANCELLED',
    message: 'Job cancelled'
  }
} as const

const transcriptionJobQueuedStatusSchema = transcriptionJobStatusCommonSchema
  .extend({
    status: z.literal('queued').openapi({ example: transcriptionJobSummaryExample.status, description: 'Queued Transcription Job waiting for background processing.' })
  })
  .openapi('TranscriptionJobQueuedStatusResponse')

const transcriptionJobProcessingStatusSchema = transcriptionJobStatusCommonSchema
  .extend({
    status: z.literal('processing').openapi({ example: transcriptionJobProcessingExample.status, description: 'Transcription Job actively processing uploaded media.' }),
    current_chunk: z.number().int().nonnegative().openapi({ example: transcriptionJobProcessingExample.current_chunk, description: 'Current zero-based chunk index while processing.' }),
    total_chunks: z.number().int().positive().optional().openapi({ example: transcriptionJobProcessingExample.total_chunks, description: 'Total number of normalized chunks for the job when chunk metadata is available.' }),
    duration_seconds: z.number().nonnegative().optional().openapi({ example: transcriptionJobProcessingExample.duration_seconds, description: 'Media duration in seconds when known during processing.' }),
    processing_seconds_elapsed: z.number().nonnegative().openapi({
      example: transcriptionJobProcessingExample.processing_seconds_elapsed,
      description: 'Elapsed processing time in seconds for the current in-progress job.'
    }),
    model: z.string().optional().openapi({ example: transcriptionJobProcessingExample.model, description: 'Transcription model used for processed chunks when known.' }),
    started_at: transcriptionJobDateTimeSchema.openapi({
      example: transcriptionJobProcessingExample.started_at,
      description: 'When processing started.'
    })
  })
  .openapi('TranscriptionJobProcessingStatusResponse')

const transcriptionJobCompletedStatusSchema = transcriptionJobStatusCommonSchema
  .extend({
    status: z.literal('completed').openapi({ example: transcriptionJobCompletedExample.status, description: 'Completed Transcription Job with a final result available.' }),
    current_chunk: z.number().int().nonnegative().openapi({ example: transcriptionJobCompletedExample.current_chunk, description: 'Final zero-based chunk cursor after completion.' }),
    total_chunks: z.number().int().positive().openapi({ example: transcriptionJobCompletedExample.total_chunks, description: 'Total number of normalized chunks processed for the job.' }),
    duration_seconds: z.number().nonnegative().openapi({ example: transcriptionJobCompletedExample.duration_seconds, description: 'Media duration in seconds.' }),
    processing_seconds: z.number().nonnegative().openapi({
      example: transcriptionJobCompletedExample.processing_seconds,
      description: 'Total transcription processing time in seconds.'
    }),
    model: z.string().openapi({ example: transcriptionJobCompletedExample.model, description: 'Transcription model used for the completed job.' }),
    started_at: transcriptionJobDateTimeSchema.openapi({
      example: transcriptionJobCompletedExample.started_at,
      description: 'When processing started.'
    }),
    completed_at: transcriptionJobDateTimeSchema.openapi({
      example: transcriptionJobCompletedExample.completed_at,
      description: 'When the job completed successfully.'
    }),
    result_url: z.string().openapi({
      example: transcriptionJobCompletedExample.result_url,
      description: 'Relative URL for fetching the completed Job Result.'
    })
  })
  .openapi('TranscriptionJobCompletedStatusResponse')

const transcriptionJobFailedStatusSchema = transcriptionJobStatusCommonSchema
  .extend({
    status: z.literal('failed').openapi({ example: transcriptionJobFailedExample.status, description: 'Failed Transcription Job with terminal error details.' }),
    current_chunk: z.number().int().nonnegative().optional().openapi({ example: transcriptionJobFailedExample.current_chunk, description: 'Last chunk cursor reached before failure, when available.' }),
    total_chunks: z.number().int().positive().optional().openapi({ example: transcriptionJobFailedExample.total_chunks, description: 'Total number of normalized chunks for the job when known.' }),
    duration_seconds: z.number().nonnegative().optional().openapi({ example: transcriptionJobFailedExample.duration_seconds, description: 'Media duration in seconds when known.' }),
    model: z.string().optional().openapi({ example: transcriptionJobFailedExample.model, description: 'Transcription model used before the failure, when known.' }),
    started_at: transcriptionJobDateTimeSchema.optional().openapi({
      example: transcriptionJobFailedExample.started_at,
      description: 'When processing started, if it started before the failure.'
    }),
    completed_at: transcriptionJobDateTimeSchema.openapi({
      example: transcriptionJobFailedExample.completed_at,
      description: 'When the job reached the failed terminal state.'
    }),
    error: transcriptionJobErrorSchema.openapi({ example: transcriptionJobFailedExample.error, description: 'Stable failure code and message for the terminal job failure.' })
  })
  .openapi('TranscriptionJobFailedStatusResponse')

function createTranscriptionJobCancelledSchema(name: string, description: string) {
  return transcriptionJobStatusCommonSchema
    .extend({
      status: z.literal('cancelled').openapi({ example: transcriptionJobCancelledExample.status, description: 'Cancelled Transcription Job.' }),
      current_chunk: z.number().int().nonnegative().optional().openapi({ example: 3, description: 'Last chunk cursor reached before cancellation, when available.' }),
      total_chunks: z.number().int().positive().optional().openapi({ example: 12, description: 'Total number of normalized chunks for the job when known.' }),
      duration_seconds: z.number().nonnegative().optional().openapi({ example: 720.5, description: 'Media duration in seconds when known.' }),
      model: z.string().optional().openapi({ example: 'large-v3-turbo', description: 'Transcription model used before cancellation, when known.' }),
      started_at: transcriptionJobDateTimeSchema.optional().openapi({
        example: '2026-07-11T00:01:00.000Z',
        description: 'When processing started, if cancellation happened after processing began.'
      }),
      completed_at: transcriptionJobDateTimeSchema.openapi({
        example: transcriptionJobCancelledExample.completed_at,
        description: 'When the job reached the cancelled terminal state.'
      }),
      error: transcriptionJobErrorSchema.openapi({
        example: transcriptionJobCancelledExample.error,
        description: 'Stable cancellation code and message.'
      })
    })
    .openapi(name, { description })
}

const transcriptionJobCancelledStatusSchema = createTranscriptionJobCancelledSchema(
  'TranscriptionJobCancelledStatusResponse',
  'Cancelled Transcription Job status response.'
)

const transcriptionJobStatusResponseSchema = z
  .union([
    transcriptionJobQueuedStatusSchema,
    transcriptionJobProcessingStatusSchema,
    transcriptionJobCompletedStatusSchema,
    transcriptionJobFailedStatusSchema,
    transcriptionJobCancelledStatusSchema
  ])
  .openapi('TranscriptionJobStatusResponse')

const transcriptionJobNotFoundExample = { error: 'not_found' } as const
const transcriptionJobNotFoundResponseSchema = createLiteralErrorSchema('TranscriptionJobNotFoundResponse', 'not_found')

const transcriptionJobResultSegmentExample = {
  start: 0,
  end: 0.5,
  text: 'hello',
  chunk_index: 0
} as const

const transcriptionJobResultSegmentSchema = z
  .object({
    start: z.number().openapi({ example: transcriptionJobResultSegmentExample.start, description: 'Segment start time in seconds.' }),
    end: z.number().openapi({ example: transcriptionJobResultSegmentExample.end, description: 'Segment end time in seconds.' }),
    text: z.string().openapi({ example: transcriptionJobResultSegmentExample.text, description: 'Transcript text for the segment.' }),
    chunk_index: z.number().int().nonnegative().openapi({
      example: transcriptionJobResultSegmentExample.chunk_index,
      description: 'Zero-based chunk index that produced the segment.'
    })
  })
  .openapi('TranscriptionJobResultSegment')

const transcriptionJobResultResponseExample = {
  job_id: transcriptionJobIdExample,
  status: 'completed',
  text: 'hello',
  segments: [transcriptionJobResultSegmentExample],
  duration_seconds: 0.5,
  processing_seconds: 0.2,
  level: 'medium',
  language: 'auto',
  detected_language: 'en',
  model: 'distil-small.en'
} as const

const transcriptionJobResultResponseSchema = z
  .object({
    job_id: z.string().openapi({ example: transcriptionJobResultResponseExample.job_id, description: 'Public Transcription Job identifier.' }),
    status: z.literal('completed').openapi({ example: transcriptionJobResultResponseExample.status, description: 'Completed Transcription Job state for final result retrieval.' }),
    text: z.string().openapi({ example: transcriptionJobResultResponseExample.text, description: 'Full transcript text for the completed job.' }),
    segments: z.array(transcriptionJobResultSegmentSchema).openapi({
      example: transcriptionJobResultResponseExample.segments,
      description: 'Timestamped transcript segments in playback order with chunk provenance.'
    }),
    duration_seconds: z.number().openapi({
      example: transcriptionJobResultResponseExample.duration_seconds,
      description: 'Media duration in seconds.'
    }),
    processing_seconds: z.number().openapi({
      example: transcriptionJobResultResponseExample.processing_seconds,
      description: 'Total transcription processing time in seconds.'
    }),
    level: z.enum(TRANSCRIPTION_LEVELS).openapi({
      example: transcriptionJobResultResponseExample.level,
      description: 'Normalized transcription level used for the job.'
    }),
    language: z.enum(TRANSCRIPTION_LANGUAGE_HINTS).openapi({
      example: transcriptionJobResultResponseExample.language,
      description: 'Normalized request Language Hint used for the job.'
    }),
    detected_language: z.string().nullable().openapi({
      example: transcriptionJobResultResponseExample.detected_language,
      description: 'Detected Language returned by the model, when available.'
    }),
    model: z.string().openapi({
      example: transcriptionJobResultResponseExample.model,
      description: 'Transcription model identifier returned by the worker.'
    })
  })
  .openapi('TranscriptionJobResultResponse')

const transcriptionJobResultNotCompletedExample = {
  error: 'job_not_completed',
  status: 'queued'
} as const

const transcriptionJobResultNotCompletedResponseSchema = z
  .object({
    error: z.literal('job_not_completed').openapi({ example: transcriptionJobResultNotCompletedExample.error }),
    status: z.enum(['queued', 'processing']).openapi({
      example: transcriptionJobResultNotCompletedExample.status,
      description: 'Current in-progress Transcription Job state preventing result retrieval.'
    })
  })
  .openapi('TranscriptionJobResultNotCompletedResponse')

const transcriptionJobResultFailedExample = {
  error: {
    code: 'TRANSCRIPTION_WORKER_FAILED',
    message: 'Transcription job failed'
  }
} as const

const transcriptionJobResultFailedResponseSchema = z
  .object({
    error: transcriptionJobErrorSchema.openapi({
      example: transcriptionJobResultFailedExample.error,
      description: 'Stable failure code and message for the failed Transcription Job.'
    })
  })
  .openapi('TranscriptionJobResultFailedResponse')

const transcriptionJobResultCancelledExample = { error: 'job_cancelled' } as const
const transcriptionJobResultCancelledResponseSchema = createLiteralErrorSchema('TranscriptionJobResultCancelledResponse', 'job_cancelled')

const transcriptionJobResultMissingExample = { error: 'job_result_missing' } as const
const transcriptionJobResultMissingResponseSchema = createLiteralErrorSchema('TranscriptionJobResultMissingResponse', 'job_result_missing')

const transcriptionJobAlreadyTerminalExample = {
  error: 'job_already_terminal',
  status: 'completed'
} as const

const transcriptionJobAlreadyTerminalResponseSchema = z
  .object({
    error: z.literal('job_already_terminal').openapi({ example: transcriptionJobAlreadyTerminalExample.error }),
    status: z.enum(['completed', 'failed']).openapi({
      example: transcriptionJobAlreadyTerminalExample.status,
      description: 'Existing terminal Transcription Job state that cannot be cancelled.'
    })
  })
  .openapi('TranscriptionJobAlreadyTerminalResponse')

const transcriptionJobCancellationResponseSchema = createTranscriptionJobCancelledSchema(
  'TranscriptionJobCancellationResponse',
  'Cancelled Transcription Job returned for successful or idempotent cancellation requests.'
)

const transcriptionWebhookSignatureHeaderSchema = z.string().optional().openapi({
  param: {
    name: 'x-girke-signature',
    in: 'header'
  },
  example: 'sha256=5b1a6c3b1fd7ee4a1bbfd87f57ce5b2b3af0f7f5c0cd6fb948f3e7f0da1d9f4d',
  description: 'Optional HMAC SHA-256 signature of the JSON payload. Present when Girke API is configured with a webhook secret.'
})

const transcriptionWebhookHeadersSchema = z.object({
  'x-girke-signature': transcriptionWebhookSignatureHeaderSchema
})

const transcriptionJobCompletedWebhookPayloadExample = {
  event: 'transcription.job.completed',
  job: transcriptionJobCompletedExample
} as const

const transcriptionJobCompletedWebhookPayloadSchema = z
  .object({
    event: z.literal('transcription.job.completed').openapi({
      example: transcriptionJobCompletedWebhookPayloadExample.event,
      description: 'Terminal webhook event sent after a Transcription Job completes successfully.'
    }),
    job: transcriptionJobCompletedStatusSchema
  })
  .openapi('TranscriptionJobCompletedWebhookPayload')

const transcriptionJobFailedWebhookPayloadExample = {
  event: 'transcription.job.failed',
  job: transcriptionJobFailedExample
} as const

const transcriptionJobFailedWebhookPayloadSchema = z
  .object({
    event: z.literal('transcription.job.failed').openapi({
      example: transcriptionJobFailedWebhookPayloadExample.event,
      description: 'Terminal webhook event sent after a Transcription Job fails.'
    }),
    job: transcriptionJobFailedStatusSchema
  })
  .openapi('TranscriptionJobFailedWebhookPayload')

const transcriptionJobCancelledWebhookPayloadExample = {
  event: 'transcription.job.cancelled',
  job: transcriptionJobCancelledExample
} as const

const transcriptionJobCancelledWebhookPayloadSchema = z
  .object({
    event: z.literal('transcription.job.cancelled').openapi({
      example: transcriptionJobCancelledWebhookPayloadExample.event,
      description: 'Terminal webhook event sent after a Transcription Job is cancelled.'
    }),
    job: transcriptionJobCancelledStatusSchema
  })
  .openapi('TranscriptionJobCancelledWebhookPayload')

function registerTranscriptionWebhook(
  app: OpenAPIHono<AppEnv>,
  name: string,
  operationId: string,
  summary: string,
  payloadSchema:
    | typeof transcriptionJobCompletedWebhookPayloadSchema
    | typeof transcriptionJobFailedWebhookPayloadSchema
    | typeof transcriptionJobCancelledWebhookPayloadSchema,
  payloadExample:
    | typeof transcriptionJobCompletedWebhookPayloadExample
    | typeof transcriptionJobFailedWebhookPayloadExample
    | typeof transcriptionJobCancelledWebhookPayloadExample
) {
  app.openAPIRegistry.registerWebhook({
    method: 'post',
    path: name,
    operationId,
    tags: [TRANSCRIPTION_TAG.name],
    summary,
    description:
      'Outgoing HTTPS webhook sent to the caller-configured webhook_url. Non-2xx receiver responses or delivery failures trigger retry attempts with exponential backoff and do not change the terminal Transcription Job status. When a webhook secret is configured, the x-girke-signature header contains an HMAC SHA-256 of the JSON request body.',
    request: {
      headers: transcriptionWebhookHeadersSchema,
      body: {
        required: true,
        description: 'Webhook JSON payload sent for the terminal Transcription Job event.',
        content: {
          'application/json': {
            schema: payloadSchema,
            example: payloadExample
          }
        }
      }
    },
    responses: {
      '2XX': {
        description: 'Webhook receiver acknowledged the delivery.'
      },
      default: {
        description:
          'Any non-2xx receiver response is treated as a delivery failure and may be retried without changing the terminal Transcription Job status.'
      }
    }
  })
}

export function registerTranscriptionWebhooks(app: OpenAPIHono<AppEnv>) {
  registerTranscriptionWebhook(
    app,
    'transcription.job.completed',
    'deliverTranscriptionJobCompletedWebhook',
    'Deliver completed Transcription Job webhook',
    transcriptionJobCompletedWebhookPayloadSchema,
    transcriptionJobCompletedWebhookPayloadExample
  )
  registerTranscriptionWebhook(
    app,
    'transcription.job.failed',
    'deliverTranscriptionJobFailedWebhook',
    'Deliver failed Transcription Job webhook',
    transcriptionJobFailedWebhookPayloadSchema,
    transcriptionJobFailedWebhookPayloadExample
  )
  registerTranscriptionWebhook(
    app,
    'transcription.job.cancelled',
    'deliverTranscriptionJobCancelledWebhook',
    'Deliver cancelled Transcription Job webhook',
    transcriptionJobCancelledWebhookPayloadSchema,
    transcriptionJobCancelledWebhookPayloadExample
  )
}

const listTranscriptionJobsRoute = createRoute({
  method: 'get',
  path: '/jobs',
  operationId: 'listTranscriptionJobs',
  tags: [TRANSCRIPTION_TAG.name],
  summary: 'List transcription jobs',
  description: 'Returns Transcription Jobs owned by the authenticated API Token only.',
  security: PROTECTED_BEARER_SECURITY,
  responses: {
    200: createJsonResponse('Token-owned Transcription Jobs.', transcriptionJobListResponseSchema, transcriptionJobListResponseExample),
    401: unauthorizedErrorResponse
  }
})

const createTranscriptionJobRoute = createRoute({
  method: 'post',
  path: '/jobs',
  operationId: 'createTranscriptionJob',
  tags: [TRANSCRIPTION_TAG.name],
  summary: 'Create an async transcription job',
  description:
    'Uploads audio or video once, stores a Transcription Job owned by the authenticated API Token, and queues background processing.',
  security: PROTECTED_BEARER_SECURITY,
  request: {
    required: true,
    body: {
      required: true,
      description:
        'Multipart upload fields for async Transcription Job creation. Omitted level defaults to medium, omitted language defaults to auto, webhook_url must be HTTPS when provided.',
      content: {
        'multipart/form-data': {
          schema: transcriptionJobCreateRequestSchema
        }
      }
    }
  },
  responses: {
    202: createJsonResponse(
      'Transcription Job accepted and queued.',
      transcriptionJobCreateAcceptedResponseSchema,
      transcriptionJobCreateAcceptedResponseExample
    ),
    400: createJsonResponse(
      'Missing file or invalid multipart field value.',
      transcriptionJobCreateBadRequestResponseSchema,
      { error: 'file_required' }
    ),
    401: unauthorizedErrorResponse,
    413: createJsonResponse(
      'Upload exceeds the async body size limit.',
      transcriptionJobCreateUploadTooLargeResponseSchema,
      transcriptionJobCreateUploadTooLargeExample
    ),
    415: createJsonResponse(
      'Uploaded filename extension is not supported for transcription.',
      transcriptionJobCreateUnsupportedMediaResponseSchema,
      { error: 'unsupported_media_format' }
    ),
    422: createJsonResponse(
      'Uploaded media duration exceeds the async job limit.',
      transcriptionJobCreateMediaDurationExceededResponseSchema,
      transcriptionJobCreateMediaDurationExceededExample
    ),
    500: createJsonResponse(
      'Unexpected server failure while creating the Transcription Job.',
      transcriptionInternalServerErrorResponseSchema,
      transcriptionInternalServerErrorExample
    )
  }
})

const getTranscriptionJobRoute = createRoute({
  method: 'get',
  path: '/jobs/{job_id}',
  operationId: 'getTranscriptionJob',
  tags: [TRANSCRIPTION_TAG.name],
  summary: 'Get transcription job status',
  description:
    'Returns the current Transcription Job lifecycle state for the authenticated owner. Jobs owned by another API Token are returned as not found.',
  security: PROTECTED_BEARER_SECURITY,
  request: {
    params: transcriptionJobIdParamsSchema
  },
  responses: {
    200: createJsonResponse(
      'Queued, processing, completed, failed, or cancelled Transcription Job status.',
      transcriptionJobStatusResponseSchema,
      transcriptionJobCompletedExample
    ),
    401: unauthorizedErrorResponse,
    404: createJsonResponse(
      'Unknown Transcription Job or a job owned by another API Token.',
      transcriptionJobNotFoundResponseSchema,
      transcriptionJobNotFoundExample
    )
  }
})

const getTranscriptionJobResultRoute = createRoute({
  method: 'get',
  path: '/jobs/{job_id}/result',
  operationId: 'getTranscriptionJobResult',
  tags: [TRANSCRIPTION_TAG.name],
  summary: 'Get transcription job result',
  description:
    'Returns the final transcript when a Transcription Job completes. Queued and processing jobs report not completed, failed jobs return terminal error details, and cancelled jobs return a dedicated cancellation response.',
  security: PROTECTED_BEARER_SECURITY,
  request: {
    params: transcriptionJobIdParamsSchema
  },
  responses: {
    200: createJsonResponse('Completed Transcription Job result.', transcriptionJobResultResponseSchema, transcriptionJobResultResponseExample),
    401: unauthorizedErrorResponse,
    404: createJsonResponse(
      'Unknown Transcription Job or a job owned by another API Token.',
      transcriptionJobNotFoundResponseSchema,
      transcriptionJobNotFoundExample
    ),
    409: createJsonResponse(
      'Transcription Job has not completed yet.',
      transcriptionJobResultNotCompletedResponseSchema,
      transcriptionJobResultNotCompletedExample
    ),
    410: createJsonResponse(
      'Transcription Job was cancelled before a result became available.',
      transcriptionJobResultCancelledResponseSchema,
      transcriptionJobResultCancelledExample
    ),
    422: createJsonResponse(
      'Transcription Job failed and no completed result is available.',
      transcriptionJobResultFailedResponseSchema,
      transcriptionJobResultFailedExample
    ),
    500: createJsonResponse(
      'Completed Transcription Job has a missing stored result.',
      transcriptionJobResultMissingResponseSchema,
      transcriptionJobResultMissingExample
    )
  }
})

const cancelTranscriptionJobRoute = createRoute({
  method: 'delete',
  path: '/jobs/{job_id}',
  operationId: 'cancelTranscriptionJob',
  tags: [TRANSCRIPTION_TAG.name],
  summary: 'Cancel a transcription job',
  description:
    'Cancels a queued or processing Transcription Job. Completed and failed jobs are already terminal and cannot be cancelled. Cancelling an already cancelled job is idempotent.',
  security: PROTECTED_BEARER_SECURITY,
  request: {
    params: transcriptionJobIdParamsSchema
  },
  responses: {
    200: createJsonResponse(
      'Cancelled Transcription Job returned for successful or idempotent cancellation.',
      transcriptionJobCancellationResponseSchema,
      transcriptionJobCancelledExample
    ),
    401: unauthorizedErrorResponse,
    404: createJsonResponse(
      'Unknown Transcription Job or a job owned by another API Token.',
      transcriptionJobNotFoundResponseSchema,
      transcriptionJobNotFoundExample
    ),
    409: createJsonResponse(
      'Transcription Job is already in a terminal completed or failed state.',
      transcriptionJobAlreadyTerminalResponseSchema,
      transcriptionJobAlreadyTerminalExample
    )
  }
})

const transcriptionSyncRoute = createRoute({
  method: 'post',
  path: '/transcribe',
  operationId: 'transcribeSynchronously',
  tags: [TRANSCRIPTION_TAG.name],
  summary: 'Synchronously transcribe a short clip',
  description:
    'Uploads a short audio or video clip, normalizes level and Language Hint values, and returns the transcript inline. Longer media should use Transcription Jobs instead.',
  security: PROTECTED_BEARER_SECURITY,
  request: {
    required: true,
    body: {
      required: true,
      description:
        'Multipart upload fields for short synchronous transcription. Omitted level defaults to medium and omitted language defaults to auto detection.',
      content: {
        'multipart/form-data': {
          schema: transcriptionSyncRequestSchema
        }
      }
    }
  },
  responses: {
    200: createJsonResponse(
      'Synchronous transcription completed successfully.',
      whisperTranscriptionResponseSchema,
      transcriptionSyncResponseExample
    ),
    400: createJsonResponse(
      'Missing file or invalid multipart field value.',
      transcriptionSyncBadRequestResponseSchema,
      { error: 'file_required' }
    ),
    401: unauthorizedErrorResponse,
    413: createJsonResponse(
      'Upload exceeds the synchronous body size limit. Use Transcription Jobs for larger media.',
      transcriptionSyncUploadTooLargeResponseSchema,
      transcriptionSyncUploadTooLargeExample
    ),
    415: createJsonResponse(
      'Uploaded filename extension is not supported for transcription.',
      transcriptionSyncUnsupportedMediaResponseSchema,
      { error: 'unsupported_media_format' }
    ),
    422: createJsonResponse(
      'Media normalization failed or the uploaded clip exceeds the synchronous duration limit.',
      transcriptionSyncUnprocessableEntityResponseSchema,
      transcriptionSyncMediaTooLongExample
    ),
    502: createJsonResponse(
      'Whisper sidecar failed while processing the synchronous transcription request.',
      transcriptionSyncWhisperFailedResponseSchema,
      { error: 'whisper_failed' }
    )
  }
})

const transcriptionMetadataRoute = createRoute({
  method: 'get',
  path: '/',
  operationId: 'getTranscriptionMetadata',
  tags: [TRANSCRIPTION_TAG.name],
  summary: 'Get transcription metadata',
  description:
    'Returns supported transcription levels, request Language Hint values, the default level, optional language behavior, and accepted media extensions.',
  security: PROTECTED_BEARER_SECURITY,
  responses: {
    200: createJsonResponse('Supported transcription metadata.', transcriptionMetadataResponseSchema, transcriptionMetadataResponseExample),
    401: unauthorizedErrorResponse
  }
})

export function transcriptionRoutes(opts: TranscriptionRouteOptions = {}) {
  const app = new OpenAPIHono<AppEnv>()
  const whisperUrl = opts.whisperUrl ?? 'http://whisper:8000'
  const whisperFetch = opts.whisperFetch ?? fetch
  const uploadDir = opts.uploadDir ?? './var/transcription-uploads'
  const jobStore = opts.jobStore ?? new InMemoryTranscriptionJobStore()
  const mediaProcessor = opts.mediaProcessor ?? createFfmpegMediaProcessor()
  const durationProbe = opts.durationProbe ?? createFfmpegDurationProbe()
  const webhookDispatcher =
    opts.webhookDispatcher ??
    createTranscriptionWebhookDispatcher({
      webhookFetch: opts.webhookFetch,
      webhookSecret: opts.webhookSecret,
      maxAttempts: opts.webhookMaxAttempts,
      retryBaseDelayMs: opts.webhookRetryBaseDelayMs
    })
  const keepMedia = opts.keepMedia ?? false
  const syncMaxUploadBytes = opts.syncMaxUploadBytes ?? DEFAULT_SYNC_MAX_UPLOAD_BYTES
  const syncMaxDurationSeconds = opts.syncMaxDurationSeconds ?? DEFAULT_SYNC_MAX_DURATION_SECONDS
  const asyncMaxUploadBytes = opts.asyncMaxUploadBytes ?? DEFAULT_ASYNC_MAX_UPLOAD_BYTES
  const asyncMaxDurationSeconds = opts.asyncMaxDurationSeconds ?? DEFAULT_ASYNC_MAX_DURATION_SECONDS
  const worker =
    opts.worker === undefined
      ? new InProcessTranscriptionWorker({ store: jobStore, whisperUrl, whisperFetch, mediaProcessor, keepMedia, asyncMaxDurationSeconds, webhookDispatcher })
      : opts.worker

  app.openapi(transcriptionMetadataRoute, (c) => c.json(createTranscriptionMetadataResponse(), 200))

  app.openapi(listTranscriptionJobsRoute, async (c) => {
    const apiToken = c.get('apiToken')
    const jobs = await jobStore.listForToken(apiToken.id)
    const responseBody: TranscriptionJobListResponse = { jobs: jobs.map(serializeJobSummary) }
    return c.json(responseBody, 200)
  })

  app.openapi(
    createTranscriptionJobRoute,
    async (c) => {
      const apiToken = c.get('apiToken')
      const form = c.req.valid('form')
      const file = form.file
      const level = form.level
      const language = form.language
      if (file.size > asyncMaxUploadBytes) {
        return c.json({ error: 'upload_too_large', max_bytes: asyncMaxUploadBytes }, 413)
      }
      if (!isSupportedMedia(file.name)) {
        return c.json({ error: 'unsupported_media_format' }, 415)
      }
      const webhookUrl = form.webhook_url ?? null

      await mkdir(uploadDir, { recursive: true })
      const uploadPath = join(uploadDir, `${createPublicJobId()}-${safeFilename(file.name)}`)
      await writeFile(uploadPath, Buffer.from(await file.arrayBuffer()))
      const duration = await durationProbe.probe(uploadPath)
      if (duration.durationSeconds !== null && duration.durationSeconds > asyncMaxDurationSeconds) {
        await rm(uploadPath, { force: true })
        return c.json({ error: 'media_duration_exceeded', max_duration_seconds: asyncMaxDurationSeconds }, 422)
      }

      const job = await jobStore.create({
        apiTokenId: apiToken.id,
        level,
        language,
        originalFilename: file.name || 'media',
        inputPath: uploadPath,
        webhookUrl
      })
      worker?.enqueue(job.publicId)

      return c.json(serializeCreatedJob(job), 202)
    },
    (result, c) => {
      if (result.success) return

      return c.json(getTranscriptionJobCreateBadRequestBody(result.error.issues), 400)
    }
  )

  app.openapi(
    transcriptionSyncRoute,
    async (c) => {
      const form = c.req.valid('form')
      const file = form.file
      const level = form.level
      const language = form.language
      if (file.size > syncMaxUploadBytes) {
        return c.json(createTranscriptionSyncUploadTooLargeBody(syncMaxUploadBytes), 413)
      }
      if (!isSupportedMedia(file.name)) {
        return c.json({ error: 'unsupported_media_format' }, 415)
      }

      const tempUpload = await writeTempUpload(file)
      try {
        const duration = await durationProbe.probe(tempUpload.path)
        if (duration.durationSeconds !== null && duration.durationSeconds > syncMaxDurationSeconds) {
          return c.json(createTranscriptionSyncMediaTooLongBody(syncMaxDurationSeconds), 422)
        }
      } finally {
        await rm(tempUpload.dir, { recursive: true, force: true })
      }

      const response = await whisperFetch(`${whisperUrl}/transcribe`, {
        method: 'POST',
        body: createWhisperTranscriptionFormData(file, level, language)
      })

      if (!response.ok) {
        if (response.status === 415) {
          return c.json({ error: 'unsupported_media_format' }, 415)
        }
        if (response.status === 422) {
          return c.json({ error: 'media_normalization_failed' }, 422)
        }
        return c.json({ error: 'whisper_failed' }, 502)
      }

      const parsed = whisperTranscriptionResponseSchema.parse(await response.json())
      if (parsed.duration_seconds > syncMaxDurationSeconds) {
        return c.json(createTranscriptionSyncMediaTooLongBody(syncMaxDurationSeconds), 422)
      }
      return c.json(parsed, 200)
    },
    (result, c) => {
      if (result.success) return

      return c.json(getTranscriptionSyncBadRequestBody(result.error.issues), 400)
    }
  )

  app.openapi(getTranscriptionJobRoute, async (c) => {
    const apiToken = c.get('apiToken')
    const { job_id } = c.req.valid('param')
    const job = await jobStore.findByPublicIdForToken(job_id, apiToken.id)
    if (!job) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(serializeJobStatus(job), 200)
  })

  app.openapi(getTranscriptionJobResultRoute, async (c) => {
    const apiToken = c.get('apiToken')
    const { job_id } = c.req.valid('param')
    const job = await jobStore.findByPublicIdForToken(job_id, apiToken.id)
    if (!job) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (job.status === 'queued' || job.status === 'processing') {
      return c.json({ error: 'job_not_completed', status: job.status }, 409)
    }
    if (job.status === 'failed') {
      return c.json(
        {
          error: serializeTerminalJobError(job.status, job.errorCode, job.errorMessage)
        },
        422
      )
    }
    if (job.status === 'cancelled') {
      return c.json({ error: 'job_cancelled' }, 410)
    }

    const result = serializeCompletedResult(job)
    if (!result) {
      return c.json({ error: 'job_result_missing' }, 500)
    }
    return c.json(result, 200)
  })

  app.openapi(cancelTranscriptionJobRoute, async (c) => {
    const apiToken = c.get('apiToken')
    const { job_id } = c.req.valid('param')
    const job = await jobStore.findByPublicIdForToken(job_id, apiToken.id)
    if (!job) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (job.status === 'completed' || job.status === 'failed') {
      return c.json({ error: 'job_already_terminal', status: job.status }, 409)
    }
    if (job.status === 'cancelled') {
      return c.json(serializeCancelledJob(job), 200)
    }

    const cancelled = await jobStore.update(job.publicId, {
      status: 'cancelled',
      cancelRequested: true,
      errorCode: 'JOB_CANCELLED',
      errorMessage: 'Job cancelled',
      completedAt: now()
    })
    if (job.status === 'queued') {
      if (keepMedia) {
        await jobStore.update(job.publicId, { mediaCleanupStatus: 'kept' })
      } else {
        await rm(job.inputPath, { force: true })
        await jobStore.update(job.publicId, { mediaCleanupStatus: 'deleted' })
      }
    }
    await webhookDispatcher.deliver(cancelled)
    return c.json(serializeCancelledJob(cancelled), 200)
  })

  return app
}
