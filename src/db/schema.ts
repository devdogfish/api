import { boolean, integer, jsonb, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const apiTokens = pgTable('api_tokens', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at')
})

export const transcriptionJobs = pgTable('transcription_jobs', {
  id: serial('id').primaryKey(),
  publicId: text('public_id').notNull().unique(),
  apiTokenId: integer('api_token_id').notNull(),
  status: text('status').notNull().default('queued'),
  level: text('level').notNull(),
  language: text('language').notNull().default('auto'),
  detectedLanguage: text('detected_language'),
  model: text('model'),
  originalFilename: text('original_filename').notNull(),
  inputPath: text('input_path').notNull(),
  normalizedAudioPath: text('normalized_audio_path'),
  mediaCleanupStatus: text('media_cleanup_status').notNull().default('pending'),
  resultJson: jsonb('result_json'),
  progress: real('progress').notNull().default(0),
  currentChunk: integer('current_chunk'),
  totalChunks: integer('total_chunks'),
  durationSeconds: real('duration_seconds'),
  processingSeconds: real('processing_seconds'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  webhookUrl: text('webhook_url'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const transcriptionChunks = pgTable('transcription_chunks', {
  id: serial('id').primaryKey(),
  jobId: integer('job_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  startSeconds: real('start_seconds').notNull(),
  endSeconds: real('end_seconds').notNull(),
  status: text('status').notNull(),
  text: text('text'),
  segmentsJson: jsonb('segments_json'),
  processingSeconds: real('processing_seconds'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})
