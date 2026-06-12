import { serve } from '@hono/node-server'
import { createApp } from './app'

const port = Number(process.env.PORT ?? '3000')
const apiKey = process.env.API_KEY
const senderApiToken = process.env.SENDER_API_TOKEN
const senderGroupId = process.env.SENDER_GROUP_ID
const smtpHost = process.env.CONTACT_SMTP_HOST
const smtpPort = process.env.CONTACT_SMTP_PORT ? Number(process.env.CONTACT_SMTP_PORT) : 465
const smtpSecure = process.env.CONTACT_SMTP_SECURE ? process.env.CONTACT_SMTP_SECURE === 'true' : smtpPort === 465
const smtpUser = process.env.CONTACT_SMTP_USER
const smtpPassword = process.env.CONTACT_SMTP_PASSWORD
const contactFromEmail = process.env.CONTACT_FROM_EMAIL
const contactReceivingEmail = process.env.CONTACT_RECEIVING_EMAIL

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

if (!apiKey) {
  throw new Error('API_KEY is required')
}

const app = createApp({
  apiKey,
  version: process.env.APP_VERSION ?? 'dev',
  whisperUrl: process.env.WHISPER_URL ?? 'http://whisper:8000',
  sender: senderConfig,
  smtp: smtpConfig
})

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(JSON.stringify({ level: 'info', msg: 'girke-api listening', port: info.port }))
})
