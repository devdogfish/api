import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { authHeaders, testApiTokenStore } from './helpers'

describe('API base routes', () => {
  test('GET /openapi.json documents public system routes and docs endpoints', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })
    const res = await app.request('/openapi.json')

    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.openapi).toBe('3.1.0')
    expect(body.info).toEqual({
      title: 'Girke API',
      version: 'test-version',
      description: 'Public API contract for Girke API.'
    })
    expect(body.components.securitySchemes).toEqual({
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Token',
        description: 'Girke API bearer token.'
      }
    })

    expect(Object.keys(body.paths).sort()).toEqual(['/', '/health', '/openapi.json', '/reference', '/version'])

    expect(body.paths['/'].get.operationId).toBe('getApiRoot')
    expect(body.paths['/'].get.tags).toEqual(['System'])
    expect(body.paths['/'].get.responses['200'].content['application/json'].example).toEqual({
      name: 'api',
      internal: 'girke-api',
      version: 'test-version'
    })
    expect(body.paths['/health'].get.operationId).toBe('getHealth')
    expect(body.paths['/health'].get.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/HealthResponse'
    )
    expect(body.paths['/version'].get.operationId).toBe('getVersion')
    expect(body.paths['/version'].get.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/VersionResponse'
    )

    expect(body.paths['/openapi.json'].get.operationId).toBe('getOpenApiDocument')
    expect(body.paths['/openapi.json'].get.tags).toEqual(['API Reference'])
    expect(body.paths['/reference'].get.operationId).toBe('getApiReference')
    expect(body.paths['/reference'].get.responses['200'].content['text/html'].schema.$ref).toBe(
      '#/components/schemas/ScalarHtmlDocument'
    )
    expect(body.components.schemas.ScalarHtmlDocument.type).toBe('string')
  })

  test('GET /reference returns public Scalar HTML pointed at the OpenAPI document', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })
    const res = await app.request('/reference')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const body = await res.text()
    expect(body).toContain('<!doctype html>')
    expect(body).toContain('/openapi.json')
    expect(body).toContain('Girke API Reference')
  })

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
