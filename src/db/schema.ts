import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const transcriptionJobs = pgTable('transcription_jobs', {
  id: serial('id').primaryKey(),
  filename: text('filename').notNull(),
  status: text('status').notNull().default('pending'),
  transcript: text('transcript'),
  createdAt: timestamp('created_at').notNull().defaultNow()
})
