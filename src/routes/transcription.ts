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

const whisperResponseSchema = z.object({
  text: z.string(),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      text: z.string()
    })
  ),
  duration_seconds: z.number(),
  processing_seconds: z.number(),
  level: z.enum(TRANSCRIPTION_LEVELS),
  language: z.enum(TRANSCRIPTION_LANGUAGE_HINTS),
  detected_language: z.string().nullable(),
  model: z.string()
})

type WhisperResponse = z.infer<typeof whisperResponseSchema>

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

export type TranscriptionResult = {
  text: string
  segments: TranscriptionSegment[]
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
  segmentsJson: TranscriptionSegment[] | null
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

function serializeJob(job: TranscriptionJobRecord): TranscriptionJobSummaryResponse {
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
    body.error = {
      code: job.errorCode ?? (job.status === 'cancelled' ? 'JOB_CANCELLED' : 'TRANSCRIPTION_WORKER_FAILED'),
      message: job.errorMessage ?? (job.status === 'cancelled' ? 'Job cancelled' : 'Transcription job failed')
    }
  }

  return body
}

function serializeResult(job: TranscriptionJobRecord) {
  if (!job.resultJson) return null
  return {
    job_id: job.publicId,
    status: job.status,
    ...job.resultJson
  }
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
        job: serializeJob(job)
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
    const segments: TranscriptionSegment[] = []
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

  private async transcribeFile(file: File, level: TranscriptionLevel, language: TranscriptionLanguage): Promise<WhisperResponse> {
    const outgoing = new FormData()
    outgoing.set('file', file, file.name)
    outgoing.set('level', level)
    if (language !== 'auto') {
      outgoing.set('language', language)
    }

    const response = await this.opts.whisperFetch(`${this.opts.whisperUrl}/transcribe`, {
      method: 'POST',
      body: outgoing
    })

    if (!response.ok) {
      if (response.status === 415) throw new TranscriptionWorkerError('UNSUPPORTED_MEDIA_FORMAT', 'Unsupported media format')
      if (response.status === 422) throw new TranscriptionWorkerError('MEDIA_NORMALIZATION_FAILED', 'Media normalization failed')
      throw new TranscriptionWorkerError('TRANSCRIPTION_WORKER_FAILED', `Whisper failed with status ${response.status}`)
    }

    return whisperResponseSchema.parse(await response.json())
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

const transcriptionJobCreateFileRequiredErrorSchema = z
  .object({
    error: z.literal('file_required').openapi({ example: 'file_required' })
  })
  .openapi('TranscriptionJobCreateFileRequiredErrorResponse')

const transcriptionJobCreateInvalidLevelErrorSchema = z
  .object({
    error: z.literal('invalid_level').openapi({ example: 'invalid_level' })
  })
  .openapi('TranscriptionJobCreateInvalidLevelErrorResponse')

const transcriptionJobCreateInvalidLanguageErrorSchema = z
  .object({
    error: z.literal('invalid_language').openapi({ example: 'invalid_language' })
  })
  .openapi('TranscriptionJobCreateInvalidLanguageErrorResponse')

const transcriptionJobCreateInvalidWebhookUrlErrorSchema = z
  .object({
    error: z.literal('invalid_webhook_url').openapi({ example: 'invalid_webhook_url' })
  })
  .openapi('TranscriptionJobCreateInvalidWebhookUrlErrorResponse')

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

const transcriptionJobCreateUnsupportedMediaResponseSchema = z
  .object({
    error: z.literal('unsupported_media_format').openapi({ example: 'unsupported_media_format' })
  })
  .openapi('TranscriptionJobCreateUnsupportedMediaResponse')

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

const transcriptionInternalServerErrorResponseSchema = z
  .object({
    error: z.literal('internal_server_error').openapi({ example: transcriptionInternalServerErrorExample.error })
  })
  .openapi('InternalServerErrorResponse')

const transcriptionJobCreateLevelFieldSchema = z
  .preprocess(
    (value) => {
      const normalized = normalizeLevel((value as FormDataEntryValue | undefined) ?? null)
      return normalized === null ? value : normalized
    },
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
    (value) => {
      const normalized = normalizeLanguage((value as FormDataEntryValue | undefined) ?? null)
      return normalized === null ? value : normalized
    },
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
    (value) => {
      const normalized = normalizeWebhookUrl((value as FormDataEntryValue | undefined) ?? null)
      if (normalized === null) return undefined
      return normalized === false ? value : normalized
    },
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
    const responseBody: TranscriptionJobListResponse = { jobs: jobs.map(serializeJob) }
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

      const responseBody: TranscriptionJobCreateAcceptedResponse = {
        job_id: job.publicId,
        status: 'queued',
        level: job.level,
        language: job.language,
        detected_language: null,
        created_at: job.createdAt.toISOString(),
        ...jobUrls(job.publicId)
      }

      return c.json(responseBody, 202)
    },
    (result, c) => {
      if (result.success) return

      const fieldErrors = new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')))
      if (fieldErrors.has('file')) {
        return c.json({ error: 'file_required' }, 400)
      }
      if (fieldErrors.has('level')) {
        return c.json({ error: 'invalid_level' }, 400)
      }
      if (fieldErrors.has('language')) {
        return c.json({ error: 'invalid_language' }, 400)
      }
      if (fieldErrors.has('webhook_url')) {
        return c.json({ error: 'invalid_webhook_url' }, 400)
      }
      return c.json({ error: 'file_required' }, 400)
    }
  )

  app.get('/jobs/:job_id', async (c) => {
    const apiToken = c.get('apiToken')
    const job = await jobStore.findByPublicIdForToken(c.req.param('job_id'), apiToken.id)
    if (!job) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(serializeJob(job))
  })

  app.get('/jobs/:job_id/result', async (c) => {
    const apiToken = c.get('apiToken')
    const job = await jobStore.findByPublicIdForToken(c.req.param('job_id'), apiToken.id)
    if (!job) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (job.status === 'queued' || job.status === 'processing') {
      return c.json({ error: 'job_not_completed', status: job.status }, 409)
    }
    if (job.status === 'failed') {
      return c.json(
        {
          error: {
            code: job.errorCode ?? 'TRANSCRIPTION_WORKER_FAILED',
            message: job.errorMessage ?? 'Transcription job failed'
          }
        },
        422
      )
    }
    if (job.status === 'cancelled') {
      return c.json({ error: 'job_cancelled' }, 410)
    }

    const result = serializeResult(job)
    if (!result) {
      return c.json({ error: 'job_result_missing' }, 500)
    }
    return c.json(result)
  })

  app.delete('/jobs/:job_id', async (c) => {
    const apiToken = c.get('apiToken')
    const job = await jobStore.findByPublicIdForToken(c.req.param('job_id'), apiToken.id)
    if (!job) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (job.status === 'completed' || job.status === 'failed') {
      return c.json({ error: 'job_already_terminal', status: job.status }, 409)
    }
    if (job.status === 'cancelled') {
      return c.json(serializeJob(job))
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
    return c.json(serializeJob(cancelled))
  })

  app.post('/transcribe', async (c) => {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return c.json({ error: 'file_required' }, 400)
    }
    if (file.size > syncMaxUploadBytes) {
      return c.json({ error: 'sync_upload_too_large', max_bytes: syncMaxUploadBytes, jobs_url: '/api/v1/transcription/jobs' }, 413)
    }
    if (!isSupportedMedia(file.name)) {
      return c.json({ error: 'unsupported_media_format' }, 415)
    }

    const level = normalizeLevel(form.get('level'))
    if (level === null) {
      return c.json({ error: 'invalid_level' }, 400)
    }

    const language = normalizeLanguage(form.get('language'))
    if (language === null) {
      return c.json({ error: 'invalid_language' }, 400)
    }

    const tempUpload = await writeTempUpload(file)
    try {
      const duration = await durationProbe.probe(tempUpload.path)
      if (duration.durationSeconds !== null && duration.durationSeconds > syncMaxDurationSeconds) {
        return c.json({ error: 'sync_media_too_long', max_duration_seconds: syncMaxDurationSeconds, jobs_url: '/api/v1/transcription/jobs' }, 422)
      }
    } finally {
      await rm(tempUpload.dir, { recursive: true, force: true })
    }

    const outgoing = new FormData()
    outgoing.set('file', file, file.name)
    outgoing.set('level', level)
    if (language !== 'auto') {
      outgoing.set('language', language)
    }

    const response = await whisperFetch(`${whisperUrl}/transcribe`, {
      method: 'POST',
      body: outgoing
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

    const parsed = whisperResponseSchema.parse(await response.json())
    if (parsed.duration_seconds > syncMaxDurationSeconds) {
      return c.json({ error: 'sync_media_too_long', max_duration_seconds: syncMaxDurationSeconds, jobs_url: '/api/v1/transcription/jobs' }, 422)
    }
    return c.json(parsed)
  })

  return app
}
