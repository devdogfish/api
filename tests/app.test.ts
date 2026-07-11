import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { authHeaders, testApiTokenStore } from './helpers'

const TEST_VERSION = 'test-version'

function createTestApp() {
  return createApp({ apiTokenStore: testApiTokenStore(), version: TEST_VERSION })
}

describe('API base routes', () => {
  test('GET /openapi.json documents public system routes and docs endpoints', async () => {
    const app = createTestApp()
    const res = await app.request('/openapi.json')

    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.openapi).toBe('3.1.0')
    expect(body.info).toEqual({
      title: 'Girke API',
      version: TEST_VERSION,
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

    expect(body.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'System' }),
        expect.objectContaining({ name: 'API Reference' }),
        expect.objectContaining({ name: 'Oona Contact' })
      ])
    )

    expect(Object.keys(body.paths).sort()).toEqual([
      '/',
      '/api/v1/oona/contact',
      '/health',
      '/openapi.json',
      '/reference',
      '/version'
    ])

    expect(body.paths['/'].get.operationId).toBe('getApiRoot')
    expect(body.paths['/'].get.tags).toEqual(['System'])
    expect(body.paths['/'].get.responses['200'].content['application/json'].example).toEqual({
      name: 'api',
      internal: 'girke-api',
      version: TEST_VERSION
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
    expect(body.paths['/openapi.json'].get.responses['200'].content['application/json'].example.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'System' }),
        expect.objectContaining({ name: 'API Reference' }),
        expect.objectContaining({ name: 'Oona Contact' })
      ])
    )
    expect(
      body.paths['/openapi.json'].get.responses['200'].content['application/json'].example.paths['/api/v1/oona/contact']
    ).toEqual({})
    expect(body.paths['/reference'].get.operationId).toBe('getApiReference')
    expect(body.paths['/reference'].get.responses['200'].content['text/html'].schema.$ref).toBe(
      '#/components/schemas/ScalarHtmlDocument'
    )
    expect(body.components.schemas.ScalarHtmlDocument.type).toBe('string')

    const contactOperation = body.paths['/api/v1/oona/contact'].post
    expect(contactOperation.operationId).toBe('submitOonaContact')
    expect(contactOperation.tags).toEqual(['Oona Contact'])
    expect(contactOperation.security).toBeUndefined()
    expect(contactOperation.requestBody.required).toBe(true)
    expect(contactOperation.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/OonaContactRequest'
    )
    expect(body.components.schemas.OonaContactRequest.required.sort()).toEqual(['email', 'message', 'name', 'subscribe'])
    expect(body.components.schemas.OonaContactRequest.properties.name.minLength).toBe(1)
    expect(body.components.schemas.OonaContactRequest.properties.name.maxLength).toBe(200)
    expect(body.components.schemas.OonaContactRequest.properties.email.format).toBe('email')
    expect(body.components.schemas.OonaContactRequest.properties.email.maxLength).toBe(320)
    expect(body.components.schemas.OonaContactRequest.properties.message.minLength).toBe(1)
    expect(body.components.schemas.OonaContactRequest.properties.message.maxLength).toBe(5000)
    expect(body.components.schemas.OonaContactRequest.properties.subscribe.type).toBe('boolean')
    expect(Object.keys(contactOperation.responses).sort()).toEqual(['200', '400', '502', '503'])
    expect(contactOperation.responses['200'].content['application/json'].example).toEqual({ success: true })
    expect(contactOperation.responses['400'].content['application/json'].example).toEqual({
      success: false,
      error: 'invalid_request'
    })
  })

  test('GET /reference returns public Scalar HTML pointed at the OpenAPI document', async () => {
    const app = createTestApp()
    const res = await app.request('/reference')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const body = await res.text()
    expect(body).toContain('<!doctype html>')
    expect(body).toContain('/openapi.json')
    expect(body).toContain('Girke API Reference')
  })

  test('GET /health returns ok without auth', async () => {
    const app = createTestApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('GET /version returns configured version without auth', async () => {
    const app = createTestApp()
    const res = await app.request('/version')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: TEST_VERSION })
  })

  test('protected routes require a valid Girke bearer token', async () => {
    const app = createTestApp()
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
