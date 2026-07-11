export const OPENAPI_DOCUMENT_PATH = '/openapi.json'
export const API_REFERENCE_PATH = '/reference'
export const BEARER_SECURITY_SCHEME = 'bearerAuth'

export function createOpenApiDocumentConfig(version: string) {
  return {
    openapi: '3.1.0' as const,
    info: {
      title: 'Girke API',
      version,
      description: 'Public API contract for Girke API.'
    },
    tags: [
      {
        name: 'System',
        description: 'Public service discovery and health routes.'
      },
      {
        name: 'API Reference',
        description: 'Public OpenAPI JSON and Scalar API reference routes.'
      }
    ],
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
