import { serve } from '@hono/node-server'
import { createApp } from './app'

const port = Number(process.env.PORT ?? '3000')
const apiKey = process.env.API_KEY
const senderApiToken = process.env.SENDER_API_TOKEN
const contactReceivingEmail = process.env.CONTACT_RECEIVING_EMAIL
const contactFromEmail = process.env.CONTACT_FROM_EMAIL
const senderGroupId = process.env.SENDER_GROUP_ID
const senderConfig =
  senderApiToken && contactReceivingEmail && contactFromEmail && senderGroupId
    ? {
        apiToken: senderApiToken,
        receivingEmail: contactReceivingEmail,
        groupId: senderGroupId,
        fromEmail: contactFromEmail
      }
    : undefined

if (!apiKey) {
  throw new Error('API_KEY is required')
}

const app = createApp({
  apiKey,
  version: process.env.APP_VERSION ?? 'dev',
  whisperUrl: process.env.WHISPER_URL ?? 'http://whisper:8000',
  sender: senderConfig
})

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(JSON.stringify({ level: 'info', msg: 'girke-api listening', port: info.port }))
})
