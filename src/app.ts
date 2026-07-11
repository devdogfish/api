import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requestLogger } from './middleware/logger'
import { bearerTokenAuth, type ApiTokenStore, type AuthVariables } from './middleware/auth'
import { transcriptionRoutes } from './routes/transcription'
import type { TranscriptionFetch, TranscriptionJobStore, TranscriptionWebhookFetch, TranscriptionWorker } from './routes/transcription'
import type { TranscriptionDurationProbe, TranscriptionMediaProcessor } from './transcription/mediaProcessor'
import { feedRoutes } from './routes/feeds'
import { oonaContactRoutes, type MailSender, type SenderConfig, type SenderFetch, type SmtpConfig } from './routes/oonaContact'

export type AppConfig = {
  apiTokenStore: ApiTokenStore
  version: string
  whisperUrl?: string
  whisperFetch?: TranscriptionFetch
  transcriptionJobStore?: TranscriptionJobStore
  transcriptionWorker?: TranscriptionWorker | null
  transcriptionMediaProcessor?: TranscriptionMediaProcessor
  transcriptionDurationProbe?: TranscriptionDurationProbe
  transcriptionUploadDir?: string
  transcriptionKeepMedia?: boolean
  transcriptionSyncMaxUploadBytes?: number
  transcriptionSyncMaxDurationSeconds?: number
  transcriptionAsyncMaxUploadBytes?: number
  transcriptionAsyncMaxDurationSeconds?: number
  transcriptionWebhookFetch?: TranscriptionWebhookFetch
  transcriptionWebhookSecret?: string
  transcriptionWebhookMaxAttempts?: number
  transcriptionWebhookRetryBaseDelayMs?: number
  sender?: SenderConfig
  senderFetch?: SenderFetch
  smtp?: SmtpConfig
  mailSender?: MailSender
}

export function createApp(config: AppConfig) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.use('*', requestLogger())
  app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 * 1024 }))

  app.get('/', (c) => c.json({ name: 'api', internal: 'girke-api', version: config.version }))
  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/version', (c) => c.json({ version: config.version }))

  app.route('/api/v1/oona/contact', oonaContactRoutes({ sender: config.sender, senderFetch: config.senderFetch, smtp: config.smtp, mailSender: config.mailSender }))

  app.use('/api/v1/*', bearerTokenAuth(config.apiTokenStore))
  app.route(
    '/api/v1/transcription',
    transcriptionRoutes({
      whisperUrl: config.whisperUrl,
      whisperFetch: config.whisperFetch,
      jobStore: config.transcriptionJobStore,
      worker: config.transcriptionWorker,
      mediaProcessor: config.transcriptionMediaProcessor,
      durationProbe: config.transcriptionDurationProbe,
      webhookFetch: config.transcriptionWebhookFetch,
      webhookSecret: config.transcriptionWebhookSecret,
      webhookMaxAttempts: config.transcriptionWebhookMaxAttempts,
      webhookRetryBaseDelayMs: config.transcriptionWebhookRetryBaseDelayMs,
      uploadDir: config.transcriptionUploadDir,
      keepMedia: config.transcriptionKeepMedia,
      syncMaxUploadBytes: config.transcriptionSyncMaxUploadBytes,
      syncMaxDurationSeconds: config.transcriptionSyncMaxDurationSeconds,
      asyncMaxUploadBytes: config.transcriptionAsyncMaxUploadBytes,
      asyncMaxDurationSeconds: config.transcriptionAsyncMaxDurationSeconds
    })
  )
  app.route('/api/v1/feeds', feedRoutes())

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((err, c) => {
    console.error(JSON.stringify({ level: 'error', msg: err.message, stack: err.stack }))
    return c.json({ error: 'internal_server_error' }, 500)
  })

  return app
}
