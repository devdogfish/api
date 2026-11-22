ALTER TABLE "api_tokens" ADD COLUMN "scopes" text[] DEFAULT '{}' NOT NULL;
