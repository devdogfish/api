import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import { transcriptionChunks, transcriptionJobs } from '../db/schema'
import type {
  CreateTranscriptionJobInput,
  TranscriptionChunkRecord,
  TranscriptionJobRecord,
  TranscriptionJobStore,
  TranscriptionJobUpdate,
  TranscriptionLanguage,
  TranscriptionLevel,
  TranscriptionResult
} from '../routes/transcription'

type Database = {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  update: (...args: any[]) => any
}

function createPublicJobId() {
  return `tr_${randomBytes(16).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  return value instanceof Date ? value : new Date(String(value))
}

function mapJob(row: any): TranscriptionJobRecord {
  return {
    id: row.id,
    publicId: row.publicId,
    apiTokenId: row.apiTokenId,
    status: row.status,
    level: row.level as TranscriptionLevel,
    language: row.language as TranscriptionLanguage,
    detectedLanguage: row.detectedLanguage ?? null,
    model: row.model ?? null,
    originalFilename: row.originalFilename,
    inputPath: row.inputPath,
    normalizedAudioPath: row.normalizedAudioPath ?? null,
    mediaCleanupStatus: row.mediaCleanupStatus,
    resultJson: (row.resultJson ?? null) as TranscriptionResult | null,
    progress: row.progress,
    currentChunk: row.currentChunk ?? null,
    totalChunks: row.totalChunks ?? null,
    durationSeconds: row.durationSeconds ?? null,
    processingSeconds: row.processingSeconds ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    webhookUrl: row.webhookUrl ?? null,
    cancelRequested: row.cancelRequested,
    createdAt: toDate(row.createdAt) ?? new Date(),
    startedAt: toDate(row.startedAt),
    completedAt: toDate(row.completedAt),
    updatedAt: toDate(row.updatedAt) ?? new Date()
  }
}

function mapChunk(row: any, publicId: string): TranscriptionChunkRecord {
  return {
    jobPublicId: publicId,
    chunkIndex: row.chunkIndex,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds,
    status: row.status,
    text: row.text ?? null,
    segmentsJson: row.segmentsJson ?? null,
    processingSeconds: row.processingSeconds ?? null,
    errorMessage: row.errorMessage ?? null
  }
}

function updateValues(update: TranscriptionJobUpdate) {
  return {
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.detectedLanguage !== undefined ? { detectedLanguage: update.detectedLanguage } : {}),
    ...(update.model !== undefined ? { model: update.model } : {}),
    ...(update.normalizedAudioPath !== undefined ? { normalizedAudioPath: update.normalizedAudioPath } : {}),
    ...(update.mediaCleanupStatus !== undefined ? { mediaCleanupStatus: update.mediaCleanupStatus } : {}),
    ...(update.resultJson !== undefined ? { resultJson: update.resultJson } : {}),
    ...(update.progress !== undefined ? { progress: update.progress } : {}),
    ...(update.currentChunk !== undefined ? { currentChunk: update.currentChunk } : {}),
    ...(update.totalChunks !== undefined ? { totalChunks: update.totalChunks } : {}),
    ...(update.durationSeconds !== undefined ? { durationSeconds: update.durationSeconds } : {}),
    ...(update.processingSeconds !== undefined ? { processingSeconds: update.processingSeconds } : {}),
    ...(update.errorCode !== undefined ? { errorCode: update.errorCode } : {}),
    ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage } : {}),
    ...(update.cancelRequested !== undefined ? { cancelRequested: update.cancelRequested } : {}),
    ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
    ...(update.completedAt !== undefined ? { completedAt: update.completedAt } : {}),
    updatedAt: new Date()
  }
}

export function createPostgresTranscriptionJobStore(database: Database): TranscriptionJobStore {
  return {
    async create(input: CreateTranscriptionJobInput) {
      const [created] = await database
        .insert(transcriptionJobs)
        .values({
          publicId: createPublicJobId(),
          apiTokenId: input.apiTokenId,
          status: 'queued',
          level: input.level,
          language: input.language,
          originalFilename: input.originalFilename,
          inputPath: input.inputPath,
          webhookUrl: input.webhookUrl,
          progress: 0
        })
        .returning()
      return mapJob(created)
    },

    async listForToken(apiTokenId: number) {
      const rows = await database.select().from(transcriptionJobs).where(eq(transcriptionJobs.apiTokenId, apiTokenId)).orderBy(desc(transcriptionJobs.createdAt))
      return rows.map(mapJob)
    },

    async findByPublicId(publicId: string) {
      const [row] = await database.select().from(transcriptionJobs).where(eq(transcriptionJobs.publicId, publicId)).limit(1)
      return row ? mapJob(row) : null
    },

    async findByPublicIdForToken(publicId: string, apiTokenId: number) {
      const [row] = await database
        .select()
        .from(transcriptionJobs)
        .where(and(eq(transcriptionJobs.publicId, publicId), eq(transcriptionJobs.apiTokenId, apiTokenId)))
        .limit(1)
      return row ? mapJob(row) : null
    },

    async update(publicId: string, update: TranscriptionJobUpdate) {
      const [updated] = await database.update(transcriptionJobs).set(updateValues(update)).where(eq(transcriptionJobs.publicId, publicId)).returning()
      if (!updated) throw new Error(`transcription job not found: ${publicId}`)
      return mapJob(updated)
    },

    async insertChunk(chunk: TranscriptionChunkRecord) {
      const job = await this.findByPublicId(chunk.jobPublicId)
      if (!job?.id) throw new Error(`transcription job not found: ${chunk.jobPublicId}`)

      await database.insert(transcriptionChunks).values({
        jobId: job.id,
        chunkIndex: chunk.chunkIndex,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        status: chunk.status,
        text: chunk.text,
        segmentsJson: chunk.segmentsJson,
        processingSeconds: chunk.processingSeconds,
        errorMessage: chunk.errorMessage,
        updatedAt: new Date()
      })
    },

    async listChunks(publicId: string) {
      const job = await this.findByPublicId(publicId)
      if (!job?.id) return []

      const rows = await database
        .select()
        .from(transcriptionChunks)
        .where(eq(transcriptionChunks.jobId, job.id))
        .orderBy(asc(transcriptionChunks.chunkIndex), asc(transcriptionChunks.id))
      return rows.map((row: any) => mapChunk(row, publicId))
    }
  }
}
