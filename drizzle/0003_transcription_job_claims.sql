ALTER TABLE "transcription_jobs" ADD COLUMN "claim_token" text;
--> statement-breakpoint
ALTER TABLE "transcription_jobs" ADD COLUMN "lease_until" timestamp with time zone;
