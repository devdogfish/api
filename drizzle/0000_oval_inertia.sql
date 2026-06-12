CREATE TABLE "transcription_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"transcript" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
