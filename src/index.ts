import { serve } from '@hono/node-server'
import { createApp } from './app'

const port = Number(process.env.PORT ?? '3000')
const apiKey = process.env.API_KEY
const senderConfig =
  process.env.SENDER_API_TOKEN && process.env.CONTACT_RECEIVING_EMAIL && process.env.SENDER_GROUP_ID
    ? {
        apiToken: process.env.SENDER_API_TOKEN,
        receivingEmail: process.env.CONTACT_RECEIVING_EMAIL,
        groupId: process.env.SENDER_GROUP_ID,
        fromEmail: process.env.CONTACT_FROM_EMAIL
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
