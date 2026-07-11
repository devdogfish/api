import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { authHeaders, testApiTokenStore } from './helpers'

describe('API base routes', () => {
  test('GET /health returns ok without auth', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('GET /version returns configured version without auth', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })
    const res = await app.request('/version')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 'test-version' })
  })

  test('protected routes require a valid Girke bearer token', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })
    const missing = await app.request('/api/v1/transcription/jobs')
    expect(missing.status).toBe(401)

    const legacy = await app.request('/api/v1/transcription/jobs', {
      headers: { 'X-API-Key': 'girke_valid' }
    })
    expect(legacy.status).toBe(401)

    const wrong = await app.request('/api/v1/transcription/jobs', {
      headers: { Authorization: 'Bearer girke_wrong' }
    })
    expect(wrong.status).toBe(401)

    const valid = await app.request('/api/v1/transcription/jobs', {
      headers: authHeaders
    })
    expect(valid.status).toBe(200)
  })
})
