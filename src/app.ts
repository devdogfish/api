import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requestLogger } from './middleware/logger'
import { apiKeyAuth } from './middleware/auth'
import { transcriptionRoutes } from './routes/transcription'
import { feedRoutes } from './routes/feeds'
import { oonaContactRoutes, type MailSender, type SenderConfig, type SenderFetch, type SmtpConfig } from './routes/oonaContact'

export type AppConfig = {
  apiKey: string
  version: string
  whisperUrl?: string
  sender?: SenderConfig
  senderFetch?: SenderFetch
  smtp?: SmtpConfig
  mailSender?: MailSender
}

export function createApp(config: AppConfig) {
  const app = new Hono()

  app.use('*', requestLogger())
  app.use('*', bodyLimit({ maxSize: 250 * 1024 * 1024 }))

  app.get('/', (c) => c.json({ name: 'api', internal: 'girke-api', version: config.version }))
  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/version', (c) => c.json({ version: config.version }))

  app.route('/api/v1/oona/contact', oonaContactRoutes({ sender: config.sender, senderFetch: config.senderFetch, smtp: config.smtp, mailSender: config.mailSender }))

  app.use('/api/v1/*', apiKeyAuth(config.apiKey))
  app.route('/api/v1/transcription', transcriptionRoutes({ whisperUrl: config.whisperUrl }))
  app.route('/api/v1/feeds', feedRoutes())

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((err, c) => {
    console.error(JSON.stringify({ level: 'error', msg: err.message, stack: err.stack }))
    return c.json({ error: 'internal_server_error' }, 500)
  })

  return app
}
