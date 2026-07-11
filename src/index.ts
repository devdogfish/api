import { serve } from '@hono/node-server'
import { createApp } from './app'
import { createPostgresApiTokenStore } from './auth/postgresTokenStore'
import { db } from './db/client'
import { createPostgresTranscriptionJobStore } from './transcription/postgresJobStore'

const port = Number(process.env.PORT ?? '3000')
const senderApiToken = process.env.SENDER_API_TOKEN
const senderGroupId = process.env.SENDER_GROUP_ID
const smtpHost = process.env.CONTACT_SMTP_HOST
const smtpPort = process.env.CONTACT_SMTP_PORT ? Number(process.env.CONTACT_SMTP_PORT) : 465
const smtpSecure = process.env.CONTACT_SMTP_SECURE ? process.env.CONTACT_SMTP_SECURE === 'true' : smtpPort === 465
const smtpUser = process.env.CONTACT_SMTP_USER
const smtpPassword = process.env.CONTACT_SMTP_PASSWORD
const contactFromEmail = process.env.CONTACT_FROM_EMAIL
const contactReceivingEmail = process.env.CONTACT_RECEIVING_EMAIL

function optionalNumber(name: string) {
  const raw = process.env[name]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

const senderConfig =
  senderApiToken && senderGroupId
    ? {
        apiToken: senderApiToken,
        groupId: senderGroupId
      }
    : undefined

const smtpConfig =
  smtpHost && smtpUser && smtpPassword && contactFromEmail && contactReceivingEmail
    ? {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        user: smtpUser,
        password: smtpPassword,
        fromEmail: contactFromEmail,
        toEmail: contactReceivingEmail
      }
    : undefined

const app = createApp({
  apiTokenStore: createPostgresApiTokenStore(),
  version: process.env.APP_VERSION ?? 'dev',
  whisperUrl: process.env.WHISPER_URL ?? 'http://whisper:8000',
  transcriptionJobStore: createPostgresTranscriptionJobStore(db),
  transcriptionUploadDir: process.env.TRANSCRIPTION_UPLOAD_DIR ?? './var/transcription-uploads',
  transcriptionKeepMedia: process.env.TRANSCRIPTION_KEEP_MEDIA === 'true',
  transcriptionSyncMaxUploadBytes: optionalNumber('TRANSCRIPTION_SYNC_MAX_UPLOAD_BYTES'),
  transcriptionSyncMaxDurationSeconds: optionalNumber('TRANSCRIPTION_SYNC_MAX_DURATION_SECONDS'),
  transcriptionAsyncMaxUploadBytes: optionalNumber('TRANSCRIPTION_ASYNC_MAX_UPLOAD_BYTES'),
  transcriptionAsyncMaxDurationSeconds: optionalNumber('TRANSCRIPTION_ASYNC_MAX_DURATION_SECONDS'),
  transcriptionWebhookSecret: process.env.TRANSCRIPTION_WEBHOOK_SECRET,
  transcriptionWebhookMaxAttempts: optionalNumber('TRANSCRIPTION_WEBHOOK_MAX_ATTEMPTS'),
  transcriptionWebhookRetryBaseDelayMs: optionalNumber('TRANSCRIPTION_WEBHOOK_RETRY_BASE_DELAY_MS'),
  sender: senderConfig,
  smtp: smtpConfig
})

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(JSON.stringify({ level: 'info', msg: 'girke-api listening', port: info.port }))
})
