import { serve } from '@hono/node-server'
import { createApp } from '../src/app'
import type { ApiTokenStore } from '../src/middleware/auth'

const port = Number(process.env.PORT ?? '3100')
const token = process.env.OCR_DEV_TOKEN ?? 'girke_valid'

const apiTokenStore: ApiTokenStore = {
  async findActiveByToken(presented) {
    return presented === token ? { id: 1, name: 'ocr-dev-token' } : null
  }
}

const app = createApp({
  apiTokenStore,
  version: 'ocr-dev'
})

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(JSON.stringify({ level: 'info', msg: 'ocr dev server listening', port: info.port, token }))
})
