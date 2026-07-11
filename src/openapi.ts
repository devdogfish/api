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
export const FEEDS_TAG = {
  name: 'Feeds',
  description: 'Protected feed capability routes.'
} as const
export const PROTECTED_BEARER_SECURITY = [{ [BEARER_SECURITY_SCHEME]: [] as string[] }]
export const UNAUTHORIZED_ERROR_EXAMPLE = { error: 'unauthorized' } as const

export const unauthorizedErrorSchema = z
  .object({
    error: z.literal('unauthorized').openapi({ example: UNAUTHORIZED_ERROR_EXAMPLE.error })
  })
  .openapi('UnauthorizedErrorResponse')

export const unauthorizedErrorResponse = {
  description: 'Missing or invalid Girke API bearer token.',
  content: {
    'application/json': {
      schema: unauthorizedErrorSchema,
      example: UNAUTHORIZED_ERROR_EXAMPLE
    }
  }
} as const

export function createOpenApiDocumentConfig(version: string) {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: API_TITLE,
      version,
      description: API_DESCRIPTION
    },
    tags: [SYSTEM_TAG, API_REFERENCE_TAG, FEEDS_TAG],
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
