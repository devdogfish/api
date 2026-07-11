CREATE TABLE "api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
