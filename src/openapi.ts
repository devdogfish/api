import { z } from '@hono/zod-openapi'

export const OPENAPI_VERSION = '3.1.0'
export const API_TITLE = 'Girke API'
export const API_DESCRIPTION = 'Public API contract for Girke API.'
export const API_NAME = 'api'
export const API_INTERNAL_NAME = 'girke-api'
export const API_REFERENCE_PAGE_TITLE = 'Girke API Reference'
export const OPENAPI_DOCUMENT_PATH = '/openapi.json'
export const API_REFERENCE_PATH = '/reference'
export const BEARER_SECURITY_SCHEME = 'bearerAuth'
export const SYSTEM_TAG = {
  name: 'System',
  description: 'Public service discovery and health routes.'
} as const
export const API_REFERENCE_TAG = {
  name: 'API Reference',
  description: 'Public OpenAPI JSON and Scalar API reference routes.'
} as const
export const OONA_CONTACT_TAG = {
  name: 'Oona Contact',
  description: 'Public Oona Kokopelli contact submission route.'
} as const
export const FEEDS_TAG = {
  name: 'Feeds',
  description: 'Protected feed capability routes.'
} as const
export const PROTECTED_BEARER_SECURITY = [{ [BEARER_SECURITY_SCHEME]: [] as string[] }]
export const UNAUTHORIZED_ERROR_BODY = { error: 'unauthorized' } as const

export function createJsonContent<TSchema extends z.ZodTypeAny>(schema: TSchema, example: unknown) {
  return {
    'application/json': {
      schema,
      example
    }
  }
}

export function createJsonResponse<TSchema extends z.ZodTypeAny>(description: string, schema: TSchema, example: unknown) {
  return {
    description,
    content: createJsonContent(schema, example)
  }
}

export const unauthorizedErrorSchema = z
  .object({
    error: z.literal('unauthorized').openapi({ example: UNAUTHORIZED_ERROR_BODY.error })
  })
  .openapi('UnauthorizedErrorResponse')

export const unauthorizedErrorResponse = createJsonResponse(
  'Missing or invalid Girke API bearer token.',
  unauthorizedErrorSchema,
  UNAUTHORIZED_ERROR_BODY
)

export function createOpenApiDocumentConfig(version: string) {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: API_TITLE,
      version,
      description: API_DESCRIPTION
    },
    tags: [SYSTEM_TAG, API_REFERENCE_TAG, OONA_CONTACT_TAG, FEEDS_TAG],
    components: {
      securitySchemes: {
        [BEARER_SECURITY_SCHEME]: {
          type: 'http' as const,
          scheme: 'bearer',
          bearerFormat: 'API Token',
          description: 'Girke API bearer token.'
        }
      }
    }
  }
}
