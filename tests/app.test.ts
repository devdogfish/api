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
  '/api/v1/transcription/jobs/{job_id}',
  '/api/v1/transcription/jobs/{job_id}/result',
  '/api/v1/transcription/transcribe',
  '/health',
  '/openapi.json',
  '/reference',
  '/version'
]
type OpenApiMethod = 'get' | 'post' | 'delete'
type OpenApiSecurity = Array<Record<string, string[]>>
type OpenApiSchema = {
  $ref?: string
  type?: string
  format?: string
  description?: string
  example?: unknown
  enum?: string[]
  required: string[]
  properties: Record<string, OpenApiSchema>
  items: OpenApiSchema
  minLength?: number
  maxLength?: number
}
type OpenApiMediaType = {
  schema: OpenApiSchema
  example?: unknown
}
type OpenApiResponse = {
  description?: string
  content: Record<string, OpenApiMediaType>
}
type OpenApiRequestBody = {
  required?: boolean
  description?: string
  content: Record<string, OpenApiMediaType>
}
type OpenApiOperation = {
  operationId?: string
  tags?: string[]
  security?: OpenApiSecurity
  description?: string
  parameters?: Array<Record<string, unknown>>
  requestBody?: OpenApiRequestBody
  responses: Record<string, OpenApiResponse>
}
type OpenApiDocument = {
  openapi: string
  info: {
    title: string
    version: string
    description: string
  }
  tags: unknown[]
  paths: Record<string, Partial<Record<OpenApiMethod, OpenApiOperation>>>
  webhooks: Record<string, { post: OpenApiOperation }>
  components: {
    securitySchemes: Record<string, unknown>
    schemas: Record<string, OpenApiSchema>
  }
}

const expectedBearerSecurity: OpenApiSecurity = [{ bearerAuth: [] }]

type ExpectedOpenApiOperation = {
  path: string
  method: OpenApiMethod
  operationId: string
  tag: string
  security?: OpenApiSecurity
  requestContentTypes?: string[]
  responseStatusCodes: string[]
  responseContentTypes: string[]
}

const expectedOpenApiOperations = [
  {
    path: '/',
    method: 'get',
    operationId: 'getApiRoot',
    tag: 'System',
    responseStatusCodes: ['200'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/health',
    method: 'get',
    operationId: 'getHealth',
    tag: 'System',
    responseStatusCodes: ['200'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/version',
    method: 'get',
    operationId: 'getVersion',
    tag: 'System',
    responseStatusCodes: ['200'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/openapi.json',
    method: 'get',
    operationId: 'getOpenApiDocument',
    tag: 'API Reference',
    responseStatusCodes: ['200'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/reference',
    method: 'get',
    operationId: 'getApiReference',
    tag: 'API Reference',
    responseStatusCodes: ['200'],
    responseContentTypes: ['text/html']
  },
  {
    path: '/api/v1/oona/contact',
    method: 'post',
    operationId: 'submitOonaContact',
    tag: 'Oona Contact',
    requestContentTypes: ['application/json'],
    responseStatusCodes: ['200', '400', '502', '503'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/feeds',
    method: 'get',
    operationId: 'listFeeds',
    tag: 'Feeds',
    security: expectedBearerSecurity,
    responseStatusCodes: ['200', '401'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/transcription',
    method: 'get',
    operationId: 'getTranscriptionMetadata',
    tag: 'Transcription',
    security: expectedBearerSecurity,
    responseStatusCodes: ['200', '401'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/transcription/transcribe',
    method: 'post',
    operationId: 'transcribeSynchronously',
    tag: 'Transcription',
    security: expectedBearerSecurity,
    requestContentTypes: ['multipart/form-data'],
    responseStatusCodes: ['200', '400', '401', '413', '415', '422', '502'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/transcription/jobs',
    method: 'get',
    operationId: 'listTranscriptionJobs',
    tag: 'Transcription',
    security: expectedBearerSecurity,
    responseStatusCodes: ['200', '401'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/transcription/jobs',
    method: 'post',
    operationId: 'createTranscriptionJob',
    tag: 'Transcription',
    security: expectedBearerSecurity,
    requestContentTypes: ['multipart/form-data'],
    responseStatusCodes: ['202', '400', '401', '413', '415', '422', '500'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/transcription/jobs/{job_id}',
    method: 'get',
    operationId: 'getTranscriptionJob',
    tag: 'Transcription',
    security: expectedBearerSecurity,
    responseStatusCodes: ['200', '401', '404'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/transcription/jobs/{job_id}/result',
    method: 'get',
    operationId: 'getTranscriptionJobResult',
    tag: 'Transcription',
    security: expectedBearerSecurity,
    responseStatusCodes: ['200', '401', '404', '409', '410', '422', '500'],
    responseContentTypes: ['application/json']
  },
  {
    path: '/api/v1/transcription/jobs/{job_id}',
    method: 'delete',
    operationId: 'cancelTranscriptionJob',
    tag: 'Transcription',
    security: expectedBearerSecurity,
    responseStatusCodes: ['200', '401', '404', '409'],
    responseContentTypes: ['application/json']
  }
] satisfies ReadonlyArray<ExpectedOpenApiOperation>

type ExpectedWebhookPayloadSchema = {
  schemaName: string
  jobSchemaName: string
}

const expectedWebhookPayloadSchemas = [
  {
    schemaName: 'TranscriptionJobCompletedWebhookPayload',
    jobSchemaName: 'TranscriptionJobCompletedStatusResponse'
  },
  {
    schemaName: 'TranscriptionJobFailedWebhookPayload',
    jobSchemaName: 'TranscriptionJobFailedStatusResponse'
  },
  {
    schemaName: 'TranscriptionJobCancelledWebhookPayload',
    jobSchemaName: 'TranscriptionJobCancelledStatusResponse'
  }
] satisfies ReadonlyArray<ExpectedWebhookPayloadSchema>

function expectPresent<T>(value: T | undefined, description: string): T {
  expect(value).toBeDefined()
  if (value === undefined) {
    throw new Error(`${description} was not defined`)
  }
  return value
}

function expectRecord(value: unknown, description: string) {
  expect(value).toBeDefined()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} was not an object`)
  }
  return value as Record<string, unknown>
}

function getOpenApiOperation(body: OpenApiDocument, path: string, method: OpenApiMethod) {
  return expectPresent(body.paths[path]?.[method], `${method.toUpperCase()} ${path} operation`)
}

function getWebhookOperation(body: OpenApiDocument, event: string) {
  return expectPresent(body.webhooks[event]?.post, `${event} webhook operation`)
}

function getRequestBody(operation: OpenApiOperation, description: string) {
  return expectPresent(operation.requestBody, `${description} request body`)
}

function getResponseExampleRecord(
  operation: OpenApiOperation,
  statusCode: string,
  contentType: string,
  description: string
) {
  const response = expectPresent(operation.responses[statusCode], `${description} response`)
  return expectRecord(response.content[contentType]?.example, description)
}

function expectWebhookPayloadSchema(body: OpenApiDocument, expected: ExpectedWebhookPayloadSchema) {
  expect(body.components.schemas[expected.schemaName]).toMatchObject({
    required: ['event', 'job'],
    properties: {
      job: {
        $ref: `#/components/schemas/${expected.jobSchemaName}`
      }
    }
  })
}

function expectOpenApiOperation(body: OpenApiDocument, expected: ExpectedOpenApiOperation) {
  const operation = getOpenApiOperation(body, expected.path, expected.method)
  expect(operation.operationId).toBe(expected.operationId)
  expect(operation.tags).toEqual([expected.tag])
  expect(operation.security).toEqual(expected.security)

  if (expected.requestContentTypes) {
    expect(operation.requestBody?.required).toBe(true)
    expect(Object.keys(operation.requestBody?.content ?? {})).toEqual(expected.requestContentTypes)
  } else {
    expect(operation.requestBody).toBeUndefined()
  }

  expect(Object.keys(operation.responses).sort()).toEqual(expected.responseStatusCodes)

  for (const statusCode of expected.responseStatusCodes) {
    expect(Object.keys(operation.responses[statusCode].content ?? {})).toEqual(expected.responseContentTypes)
  }
}

function createTestApp() {
  return createApp({ apiTokenStore: testApiTokenStore(), version: TEST_VERSION })
}

async function requestOpenApiDocument(app = createTestApp()) {
  const res = await app.request('/openapi.json')
  expect(res.status).toBe(200)
  return (await res.json()) as OpenApiDocument
}

describe('API base routes', () => {
  test('GET /openapi.json documents public routes plus protected feeds and transcription auth metadata', async () => {
    const body = await requestOpenApiDocument()
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
    for (const operation of expectedOpenApiOperations) {
      expectOpenApiOperation(body, operation)
    }

    const rootOperation = getOpenApiOperation(body, '/', 'get')
    expect(rootOperation.operationId).toBe('getApiRoot')
    expect(rootOperation.tags).toEqual(['System'])
    expect(rootOperation.security).toBeUndefined()
    expect(rootOperation.responses['200'].content['application/json'].example).toEqual({
      name: 'api',
      internal: 'girke-api',
      version: TEST_VERSION
    })
    const healthOperation = getOpenApiOperation(body, '/health', 'get')
    expect(healthOperation.operationId).toBe('getHealth')
    expect(healthOperation.security).toBeUndefined()
    expect(healthOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/HealthResponse'
    )
    const versionOperation = getOpenApiOperation(body, '/version', 'get')
    expect(versionOperation.operationId).toBe('getVersion')
    expect(versionOperation.security).toBeUndefined()
    expect(versionOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/VersionResponse'
    )

    const openApiDocumentOperation = getOpenApiOperation(body, '/openapi.json', 'get')
    expect(openApiDocumentOperation.operationId).toBe('getOpenApiDocument')
    expect(openApiDocumentOperation.tags).toEqual(['API Reference'])
    expect(openApiDocumentOperation.security).toBeUndefined()
    const openApiDocumentExample = getResponseExampleRecord(
      openApiDocumentOperation,
      '200',
      'application/json',
      'OpenAPI document example'
    )
    expect(openApiDocumentExample.tags).toEqual(expectedOpenApiTags)
    const openApiDocumentPaths = expectRecord(openApiDocumentExample.paths, 'OpenAPI document example paths')
    expect(openApiDocumentPaths['/api/v1/feeds']).toEqual({})
    expect(openApiDocumentPaths['/api/v1/transcription']).toEqual({})
    expect(openApiDocumentPaths['/api/v1/oona/contact']).toEqual({})
    const referenceOperation = getOpenApiOperation(body, '/reference', 'get')
    expect(referenceOperation.operationId).toBe('getApiReference')
    expect(referenceOperation.security).toBeUndefined()
    expect(referenceOperation.responses['200'].content['text/html'].schema.$ref).toBe(
      '#/components/schemas/ScalarHtmlDocument'
    )
    expect(body.components.schemas.ScalarHtmlDocument.type).toBe('string')

    const contactOperation = getOpenApiOperation(body, '/api/v1/oona/contact', 'post')
    const contactRequestBody = getRequestBody(contactOperation, 'submit Oona contact')
    expect(contactOperation.operationId).toBe('submitOonaContact')
    expect(contactOperation.tags).toEqual(['Oona Contact'])
    expect(contactOperation.security).toBeUndefined()
    expect(contactRequestBody.required).toBe(true)
    expect(contactRequestBody.content['application/json'].schema.$ref).toBe(
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

    const feedsOperation = getOpenApiOperation(body, '/api/v1/feeds', 'get')
    expect(feedsOperation.operationId).toBe('listFeeds')
    expect(feedsOperation.tags).toEqual(['Feeds'])
    expect(feedsOperation.security).toEqual(expectedBearerSecurity)
    expect(feedsOperation.responses['200'].content['application/json'].example).toEqual({
      feeds: []
    })
    expect(feedsOperation.responses['401'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/UnauthorizedErrorResponse'
    )
    expect(feedsOperation.responses['401'].content['application/json'].example).toEqual({
      error: 'unauthorized'
    })

    const transcriptionOperation = getOpenApiOperation(body, '/api/v1/transcription', 'get')
    expect(transcriptionOperation.operationId).toBe('getTranscriptionMetadata')
    expect(transcriptionOperation.tags).toEqual(['Transcription'])
    expect(transcriptionOperation.security).toEqual(expectedBearerSecurity)
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

    const transcriptionSyncOperation = getOpenApiOperation(body, '/api/v1/transcription/transcribe', 'post')
    const transcriptionSyncRequestBody = getRequestBody(transcriptionSyncOperation, 'sync transcription')
    expect(transcriptionSyncOperation.operationId).toBe('transcribeSynchronously')
    expect(transcriptionSyncOperation.tags).toEqual(['Transcription'])
    expect(transcriptionSyncOperation.security).toEqual(expectedBearerSecurity)
    expect(transcriptionSyncRequestBody.required).toBe(true)
    expect(Object.keys(transcriptionSyncRequestBody.content)).toEqual(['multipart/form-data'])
    expect(transcriptionSyncRequestBody.content['multipart/form-data'].schema.$ref).toBe(
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

    const transcriptionJobsListOperation = getOpenApiOperation(body, '/api/v1/transcription/jobs', 'get')
    expect(transcriptionJobsListOperation.operationId).toBe('listTranscriptionJobs')
    expect(transcriptionJobsListOperation.tags).toEqual(['Transcription'])
    expect(transcriptionJobsListOperation.security).toEqual(expectedBearerSecurity)
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

    const transcriptionJobsCreateOperation = getOpenApiOperation(body, '/api/v1/transcription/jobs', 'post')
    const transcriptionJobsCreateRequestBody = getRequestBody(transcriptionJobsCreateOperation, 'create transcription job')
    expect(transcriptionJobsCreateOperation.operationId).toBe('createTranscriptionJob')
    expect(transcriptionJobsCreateOperation.tags).toEqual(['Transcription'])
    expect(transcriptionJobsCreateOperation.security).toEqual(expectedBearerSecurity)
    expect(transcriptionJobsCreateRequestBody.required).toBe(true)
    expect(Object.keys(transcriptionJobsCreateRequestBody.content)).toEqual(['multipart/form-data'])
    expect(transcriptionJobsCreateRequestBody.content['multipart/form-data'].schema.$ref).toBe(
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

    const transcriptionJobStatusOperation = getOpenApiOperation(body, '/api/v1/transcription/jobs/{job_id}', 'get')
    expect(transcriptionJobStatusOperation.operationId).toBe('getTranscriptionJob')
    expect(transcriptionJobStatusOperation.tags).toEqual(['Transcription'])
    expect(transcriptionJobStatusOperation.security).toEqual(expectedBearerSecurity)
    expect(transcriptionJobStatusOperation.parameters).toEqual([
      expect.objectContaining({
        name: 'job_id',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ type: 'string', example: 'tr_01jzexample' })
      })
    ])
    expect(Object.keys(transcriptionJobStatusOperation.responses).sort()).toEqual(['200', '401', '404'])
    expect(transcriptionJobStatusOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobStatusResponse'
    )
    expect(transcriptionJobStatusOperation.responses['404'].content['application/json'].example).toEqual({ error: 'not_found' })

    const transcriptionJobResultOperation = getOpenApiOperation(body, '/api/v1/transcription/jobs/{job_id}/result', 'get')
    expect(transcriptionJobResultOperation.operationId).toBe('getTranscriptionJobResult')
    expect(transcriptionJobResultOperation.tags).toEqual(['Transcription'])
    expect(transcriptionJobResultOperation.security).toEqual(expectedBearerSecurity)
    expect(transcriptionJobResultOperation.parameters).toEqual([
      expect.objectContaining({
        name: 'job_id',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ type: 'string', example: 'tr_01jzexample' })
      })
    ])
    expect(Object.keys(transcriptionJobResultOperation.responses).sort()).toEqual(['200', '401', '404', '409', '410', '422', '500'])
    expect(transcriptionJobResultOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobResultResponse'
    )
    expect(transcriptionJobResultOperation.responses['409'].content['application/json'].example).toEqual({
      error: 'job_not_completed',
      status: 'queued'
    })
    expect(transcriptionJobResultOperation.responses['410'].content['application/json'].example).toEqual({ error: 'job_cancelled' })
    expect(transcriptionJobResultOperation.responses['422'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobResultFailedResponse'
    )
    expect(transcriptionJobResultOperation.responses['500'].content['application/json'].example).toEqual({ error: 'job_result_missing' })

    const transcriptionJobCancelOperation = getOpenApiOperation(body, '/api/v1/transcription/jobs/{job_id}', 'delete')
    expect(transcriptionJobCancelOperation.operationId).toBe('cancelTranscriptionJob')
    expect(transcriptionJobCancelOperation.tags).toEqual(['Transcription'])
    expect(transcriptionJobCancelOperation.security).toEqual(expectedBearerSecurity)
    expect(transcriptionJobCancelOperation.parameters).toEqual([
      expect.objectContaining({
        name: 'job_id',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ type: 'string', example: 'tr_01jzexample' })
      })
    ])
    expect(Object.keys(transcriptionJobCancelOperation.responses).sort()).toEqual(['200', '401', '404', '409'])
    expect(transcriptionJobCancelOperation.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobCancellationResponse'
    )
    expect(transcriptionJobCancelOperation.responses['409'].content['application/json'].example).toEqual({
      error: 'job_already_terminal',
      status: 'completed'
    })
  })

  test('GET /openapi.json documents transcription webhook payloads and the OpenAPI document example', async () => {
    const body = await requestOpenApiDocument()
    expect(Object.keys(body.webhooks).sort()).toEqual([
      'transcription.job.cancelled',
      'transcription.job.completed',
      'transcription.job.failed'
    ])
    for (const webhookPayloadSchema of expectedWebhookPayloadSchemas) {
      expectWebhookPayloadSchema(body, webhookPayloadSchema)
    }

    const completedWebhook = getWebhookOperation(body, 'transcription.job.completed')
    const completedWebhookRequestBody = getRequestBody(completedWebhook, 'completed transcription webhook')
    expect(completedWebhook.operationId).toBe('deliverTranscriptionJobCompletedWebhook')
    expect(completedWebhook.tags).toEqual(['Transcription'])
    expect(completedWebhook.description).toContain('retry')
    expect(completedWebhook.description).toContain('x-girke-signature')
    expect(completedWebhook.responses.default.description).toContain('without changing the terminal Transcription Job status')
    expect(completedWebhook.parameters).toEqual([
      expect.objectContaining({
        name: 'x-girke-signature',
        in: 'header',
        required: false
      })
    ])
    expect(completedWebhookRequestBody.required).toBe(true)
    expect(completedWebhookRequestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobCompletedWebhookPayload'
    )

    const failedWebhook = getWebhookOperation(body, 'transcription.job.failed')
    const failedWebhookRequestBody = getRequestBody(failedWebhook, 'failed transcription webhook')
    expect(failedWebhookRequestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobFailedWebhookPayload'
    )
    const cancelledWebhook = getWebhookOperation(body, 'transcription.job.cancelled')
    const cancelledWebhookRequestBody = getRequestBody(cancelledWebhook, 'cancelled transcription webhook')
    expect(cancelledWebhookRequestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/TranscriptionJobCancelledWebhookPayload'
    )
    const transcriptionJobsCreateOperation = getOpenApiOperation(body, '/api/v1/transcription/jobs', 'post')
    const transcriptionJobsCreateRequestBody = getRequestBody(transcriptionJobsCreateOperation, 'create transcription job')
    expect(transcriptionJobsCreateRequestBody.description).toContain('x-girke-signature')
    expect(transcriptionJobsCreateRequestBody.description).toContain(
      'do not change the terminal Transcription Job status'
    )
    expect(body.components.schemas.TranscriptionJobCreateRequest.properties.webhook_url.description).toContain(
      'completed, failed, and cancelled'
    )

    const openApiDocumentOperation = getOpenApiOperation(body, '/openapi.json', 'get')
    const openApiDocumentExample = getResponseExampleRecord(
      openApiDocumentOperation,
      '200',
      'application/json',
      'OpenAPI document example'
    )
    expect(expectRecord(openApiDocumentExample.webhooks, 'OpenAPI document example webhooks')).toEqual({
      'transcription.job.completed': {},
      'transcription.job.failed': {},
      'transcription.job.cancelled': {}
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
