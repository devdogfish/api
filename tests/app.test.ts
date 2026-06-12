import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'

describe('API base routes', () => {
  test('GET /health returns ok without auth', async () => {
    const app = createApp({ apiKey: 'secret', version: 'test-version' })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('GET /version returns configured version without auth', async () => {
    const app = createApp({ apiKey: 'secret', version: 'test-version' })
    const res = await app.request('/version')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 'test-version' })
  })

  test('protected routes require X-API-Key', async () => {
    const app = createApp({ apiKey: 'secret', version: 'test-version' })
    const missing = await app.request('/api/v1/transcription/jobs')
    expect(missing.status).toBe(401)

    const wrong = await app.request('/api/v1/transcription/jobs', {
      headers: { 'X-API-Key': 'wrong' }
    })
    expect(wrong.status).toBe(401)
  })
})
