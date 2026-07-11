ALTER TABLE "transcription_jobs" RENAME COLUMN "filename" TO "original_filename";
ALTER TABLE "transcription_jobs" DROP COLUMN IF EXISTS "transcript";
ALTER TABLE "transcription_jobs" ADD COLUMN "public_id" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "api_token_id" integer;
ALTER TABLE "transcription_jobs" ADD COLUMN "level" text DEFAULT 'medium' NOT NULL;
ALTER TABLE "transcription_jobs" ADD COLUMN "language" text DEFAULT 'auto' NOT NULL;
ALTER TABLE "transcription_jobs" ADD COLUMN "detected_language" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "model" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "input_path" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "normalized_audio_path" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "media_cleanup_status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "transcription_jobs" ADD COLUMN "result_json" jsonb;
ALTER TABLE "transcription_jobs" ADD COLUMN "progress" real DEFAULT 0 NOT NULL;
ALTER TABLE "transcription_jobs" ADD COLUMN "current_chunk" integer;
ALTER TABLE "transcription_jobs" ADD COLUMN "total_chunks" integer;
ALTER TABLE "transcription_jobs" ADD COLUMN "duration_seconds" real;
ALTER TABLE "transcription_jobs" ADD COLUMN "processing_seconds" real;
ALTER TABLE "transcription_jobs" ADD COLUMN "error_code" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "error_message" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "webhook_url" text;
ALTER TABLE "transcription_jobs" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;
ALTER TABLE "transcription_jobs" ADD COLUMN "started_at" timestamp;
ALTER TABLE "transcription_jobs" ADD COLUMN "completed_at" timestamp;
ALTER TABLE "transcription_jobs" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;
UPDATE "transcription_jobs"
SET
  "public_id" = 'tr_legacy_' || "id",
  "api_token_id" = 0,
  "input_path" = ''
WHERE "public_id" IS NULL;
ALTER TABLE "transcription_jobs" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "transcription_jobs" ALTER COLUMN "api_token_id" SET NOT NULL;
ALTER TABLE "transcription_jobs" ALTER COLUMN "input_path" SET NOT NULL;
ALTER TABLE "transcription_jobs" ALTER COLUMN "status" SET DEFAULT 'queued';
CREATE UNIQUE INDEX "transcription_jobs_public_id_unique" ON "transcription_jobs" ("public_id");

CREATE TABLE "transcription_chunks" (
  "id" serial PRIMARY KEY NOT NULL,
  "job_id" integer NOT NULL,
  "chunk_index" integer NOT NULL,
  "start_seconds" real NOT NULL,
  "end_seconds" real NOT NULL,
  "status" text NOT NULL,
  "text" text,
  "segments_json" jsonb,
  "processing_seconds" real,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
