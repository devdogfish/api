import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { authHeaders, testApiTokenStore } from './helpers'

const TEST_VERSION = 'test-version'
const expectedOpenApiTags = expect.arrayContaining([
  expect.objectContaining({ name: 'System' }),
  expect.objectContaining({ name: 'API Reference' }),
  expect.objectContaining({ name: 'Oona Contact' }),
  expect.objectContaining({ name: 'Feeds' }),
  expect.objectContaining({ name: 'Transcription' })
])
const expectedOpenApiPaths = [
  '/',
  '/api/v1/feeds',
  '/api/v1/oona/contact',
  '/api/v1/transcription',
  '/api/v1/transcription/jobs',
  '/api/v1/transcription/transcribe',
  '/health',
  '/openapi.json',
  '/reference',
  '/version'
]

function createTestApp() {
  return createApp({ apiTokenStore: testApiTokenStore(), version: TEST_VERSION })
}

describe('API base routes', () => {
  test('GET /openapi.json documents public routes plus protected feeds and transcription auth metadata', async () => {
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

    expect(body.tags).toEqual(expectedOpenApiTags)

    expect(Object.keys(body.paths).sort()).toEqual(expectedOpenApiPaths)

    expect(body.paths['/'].get.operationId).toBe('getApiRoot')
    expect(body.paths['/'].get.tags).toEqual(['System'])
    expect(body.paths['/'].get.security).toBeUndefined()
    expect(body.paths['/'].get.responses['200'].content['application/json'].example).toEqual({
      name: 'api',
      internal: 'girke-api',
      version: TEST_VERSION
    })
    expect(body.paths['/health'].get.operationId).toBe('getHealth')
    expect(body.paths['/health'].get.security).toBeUndefined()
    expect(body.paths['/health'].get.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/HealthResponse'
    )
    expect(body.paths['/version'].get.operationId).toBe('getVersion')
    expect(body.paths['/version'].get.security).toBeUndefined()
    expect(body.paths['/version'].get.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/VersionResponse'
    )

    expect(body.paths['/openapi.json'].get.operationId).toBe('getOpenApiDocument')
    expect(body.paths['/openapi.json'].get.tags).toEqual(['API Reference'])
    expect(body.paths['/openapi.json'].get.security).toBeUndefined()
    expect(body.paths['/openapi.json'].get.responses['200'].content['application/json'].example.tags).toEqual(expectedOpenApiTags)
    expect(
      body.paths['/openapi.json'].get.responses['200'].content['application/json'].example.paths['/api/v1/feeds']
    ).toEqual({})
    expect(
      body.paths['/openapi.json'].get.responses['200'].content['application/json'].example.paths['/api/v1/transcription']
    ).toEqual({})
    expect(
      body.paths['/openapi.json'].get.responses['200'].content['application/json'].example.paths['/api/v1/oona/contact']
    ).toEqual({})
    expect(body.paths['/reference'].get.operationId).toBe('getApiReference')
    expect(body.paths['/reference'].get.security).toBeUndefined()
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

    expect(body.paths['/api/v1/feeds'].get.operationId).toBe('listFeeds')
    expect(body.paths['/api/v1/feeds'].get.tags).toEqual(['Feeds'])
    expect(body.paths['/api/v1/feeds'].get.security).toEqual([{ bearerAuth: [] }])
    expect(body.paths['/api/v1/feeds'].get.responses['200'].content['application/json'].example).toEqual({
      feeds: []
    })
    expect(body.paths['/api/v1/feeds'].get.responses['401'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/UnauthorizedErrorResponse'
    )
    expect(body.paths['/api/v1/feeds'].get.responses['401'].content['application/json'].example).toEqual({
      error: 'unauthorized'
    })

    const transcriptionOperation = body.paths['/api/v1/transcription'].get
    expect(transcriptionOperation.operationId).toBe('getTranscriptionMetadata')
    expect(transcriptionOperation.tags).toEqual(['Transcription'])
    expect(transcriptionOperation.security).toEqual([{ bearerAuth: [] }])
    expect(transcriptionOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionMetadataResponse'
    )
    expect(transcriptionOperation.responses['401'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/UnauthorizedErrorResponse'
    )
    expect(body.components.schemas.TranscriptionMetadataResponse.properties.default_level.example).toBe('medium')
    expect(body.components.schemas.TranscriptionMetadataResponse.properties.language_optional.example).toBe(true)
    expect(body.components.schemas.TranscriptionMetadataResponse.properties.levels.items.enum).toEqual(['low', 'medium', 'high'])
    expect(body.components.schemas.TranscriptionMetadataResponse.properties.languages.items.$ref).toBe(
      '#/components/schemas/TranscriptionLanguageHintMetadata'
    )
    expect(body.components.schemas.TranscriptionLanguageHintMetadata.description).toContain('Detected Language')
    expect(body.components.schemas.TranscriptionLanguageHintMetadata.description).toContain('Language Hint')
    expect(body.components.schemas.TranscriptionLanguageHintMetadata.properties.code.enum).toEqual(['en', 'de'])

    const transcriptionSyncOperation = body.paths['/api/v1/transcription/transcribe'].post
    expect(transcriptionSyncOperation.operationId).toBe('transcribeSynchronously')
    expect(transcriptionSyncOperation.tags).toEqual(['Transcription'])
    expect(transcriptionSyncOperation.security).toEqual([{ bearerAuth: [] }])
    expect(transcriptionSyncOperation.requestBody.required).toBe(true)
    expect(Object.keys(transcriptionSyncOperation.requestBody.content)).toEqual(['multipart/form-data'])
    expect(transcriptionSyncOperation.requestBody.content['multipart/form-data'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionSyncRequest'
    )
    expect(Object.keys(transcriptionSyncOperation.responses).sort()).toEqual(['200', '400', '401', '413', '415', '422', '502'])
    expect(transcriptionSyncOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionSyncResponse'
    )
    expect(transcriptionSyncOperation.responses['413'].content['application/json'].example).toEqual({
      error: 'sync_upload_too_large',
      max_bytes: 262144000,
      jobs_url: '/api/v1/transcription/jobs'
    })
    expect(transcriptionSyncOperation.responses['422'].content['application/json'].example).toEqual({
      error: 'sync_media_too_long',
      max_duration_seconds: 300,
      jobs_url: '/api/v1/transcription/jobs'
    })
    expect(body.components.schemas.TranscriptionSyncRequest.required).toEqual(['file'])
    expect(body.components.schemas.TranscriptionSyncRequest.properties.file.type).toBe('string')
    expect(body.components.schemas.TranscriptionSyncRequest.properties.file.format).toBe('binary')
    expect(body.components.schemas.TranscriptionSyncRequest.properties.level.enum).toEqual(['low', 'medium', 'high'])
    expect(body.components.schemas.TranscriptionSyncRequest.properties.language.enum).toEqual(['auto', 'en', 'de'])
    expect(body.components.schemas.TranscriptionSyncResponse.required.sort()).toEqual([
      'detected_language',
      'duration_seconds',
      'language',
      'level',
      'model',
      'processing_seconds',
      'segments',
      'text'
    ])
    expect(body.components.schemas.TranscriptionSyncResponse.properties.language.description).toContain('Language Hint')
    expect(body.components.schemas.TranscriptionSyncResponse.properties.detected_language.description).toContain('Detected Language')

    const transcriptionJobsListOperation = body.paths['/api/v1/transcription/jobs'].get
    expect(transcriptionJobsListOperation.operationId).toBe('listTranscriptionJobs')
    expect(transcriptionJobsListOperation.tags).toEqual(['Transcription'])
    expect(transcriptionJobsListOperation.security).toEqual([{ bearerAuth: [] }])
    expect(Object.keys(transcriptionJobsListOperation.responses).sort()).toEqual(['200', '401'])
    expect(transcriptionJobsListOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobListResponse'
    )
    expect(transcriptionJobsListOperation.responses['401'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/UnauthorizedErrorResponse'
    )
    expect(body.components.schemas.TranscriptionJobListResponse.required).toEqual(['jobs'])
    expect(body.components.schemas.TranscriptionJobListResponse.properties.jobs.items.$ref).toBe(
      '#/components/schemas/TranscriptionJobSummary'
    )

    const transcriptionJobsCreateOperation = body.paths['/api/v1/transcription/jobs'].post
    expect(transcriptionJobsCreateOperation.operationId).toBe('createTranscriptionJob')
    expect(transcriptionJobsCreateOperation.tags).toEqual(['Transcription'])
    expect(transcriptionJobsCreateOperation.security).toEqual([{ bearerAuth: [] }])
    expect(transcriptionJobsCreateOperation.requestBody.required).toBe(true)
    expect(Object.keys(transcriptionJobsCreateOperation.requestBody.content)).toEqual(['multipart/form-data'])
    expect(transcriptionJobsCreateOperation.requestBody.content['multipart/form-data'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobCreateRequest'
    )
    expect(Object.keys(transcriptionJobsCreateOperation.responses).sort()).toEqual(['202', '400', '401', '413', '415', '422', '500'])
    expect(transcriptionJobsCreateOperation.responses['202'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobCreateAcceptedResponse'
    )
    expect(transcriptionJobsCreateOperation.responses['413'].content['application/json'].example).toEqual({
      error: 'upload_too_large',
      max_bytes: 2147483648
    })
    expect(body.components.schemas.TranscriptionJobCreateRequest.required).toEqual(['file'])
    expect(body.components.schemas.TranscriptionJobCreateRequest.properties.file.type).toBe('string')
    expect(body.components.schemas.TranscriptionJobCreateRequest.properties.file.format).toBe('binary')
    expect(body.components.schemas.TranscriptionJobCreateRequest.properties.level.enum).toEqual(['low', 'medium', 'high'])
    expect(body.components.schemas.TranscriptionJobCreateRequest.properties.language.enum).toEqual(['auto', 'en', 'de'])
    expect(body.components.schemas.TranscriptionJobCreateRequest.properties.webhook_url.format).toBe('uri')
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
    const missingFeeds = await app.request('/api/v1/feeds')
    expect(missingFeeds.status).toBe(401)
    expect(await missingFeeds.json()).toEqual({ error: 'unauthorized' })

    const missingTranscriptionMetadata = await app.request('/api/v1/transcription')
    expect(missingTranscriptionMetadata.status).toBe(401)
    expect(await missingTranscriptionMetadata.json()).toEqual({ error: 'unauthorized' })

    const legacyFeeds = await app.request('/api/v1/feeds', {
      headers: { 'X-API-Key': 'girke_valid' }
    })
    expect(legacyFeeds.status).toBe(401)
    expect(await legacyFeeds.json()).toEqual({ error: 'unauthorized' })

    const wrongFeeds = await app.request('/api/v1/feeds', {
      headers: { Authorization: 'Bearer girke_wrong' }
    })
    expect(wrongFeeds.status).toBe(401)
    expect(await wrongFeeds.json()).toEqual({ error: 'unauthorized' })

    const validFeeds = await app.request('/api/v1/feeds', {
      headers: authHeaders
    })
    expect(validFeeds.status).toBe(200)
    expect(await validFeeds.json()).toEqual({ feeds: [] })

    const validTranscriptionMetadata = await app.request('/api/v1/transcription', {
      headers: authHeaders
    })
    expect(validTranscriptionMetadata.status).toBe(200)

    const missingTranscriptionJobs = await app.request('/api/v1/transcription/jobs')
    expect(missingTranscriptionJobs.status).toBe(401)
    expect(await missingTranscriptionJobs.json()).toEqual({ error: 'unauthorized' })

    const validTranscriptionJobs = await app.request('/api/v1/transcription/jobs', {
      headers: authHeaders
    })
    expect(validTranscriptionJobs.status).toBe(200)
  })
})
