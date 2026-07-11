import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import type { AppEnv } from '../appEnv'
import { API_REFERENCE_PATH, BEARER_SECURITY_SCHEME, createOpenApiDocumentConfig, OPENAPI_DOCUMENT_PATH } from '../openapi'

const rootResponseSchema = z
  .object({
    name: z.string().openapi({ example: 'api' }),
    internal: z.string().openapi({ example: 'girke-api' }),
    version: z.string().openapi({ example: 'test-version' })
  })
  .openapi('ApiRootResponse')

const healthResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true })
  })
  .openapi('HealthResponse')

const versionResponseSchema = z
  .object({
    version: z.string().openapi({ example: 'test-version' })
  })
  .openapi('VersionResponse')

const openApiDocumentSchema = z
  .object({
    openapi: z.string().openapi({ example: '3.1.0' }),
    info: z.object({
      title: z.string().openapi({ example: 'Girke API' }),
      version: z.string().openapi({ example: 'test-version' }),
      description: z.string().openapi({ example: 'Public API contract for Girke API.' }).optional()
    }),
    tags: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional()
        })
      )
      .openapi({
        example: [
          { name: 'System', description: 'Public service discovery and health routes.' },
          { name: 'API Reference', description: 'Public OpenAPI JSON and Scalar API reference routes.' }
        ]
      })
      .optional(),
    paths: z.record(z.string(), z.any()).optional(),
    components: z
      .object({
        securitySchemes: z.record(z.string(), z.any()).optional()
      })
      .catchall(z.any())
      .optional()
  })
  .openapi('OpenApiDocument')

const scalarHtmlSchema = z.string().openapi({ example: '<!doctype html><html></html>' }).openapi('ScalarHtmlDocument')

export function registerSystemRoutes(app: OpenAPIHono<AppEnv>, version: string) {
  const openApiConfig = createOpenApiDocumentConfig(version)
  const scalarReference = Scalar<AppEnv>({
    pageTitle: 'Girke API Reference',
    url: OPENAPI_DOCUMENT_PATH
  })
  const bearerSecurityScheme = openApiConfig.components.securitySchemes[BEARER_SECURITY_SCHEME]

  app.openAPIRegistry.registerComponent('securitySchemes', BEARER_SECURITY_SCHEME, bearerSecurityScheme)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      operationId: 'getApiRoot',
      tags: ['System'],
      summary: 'Get API service metadata',
      description: 'Returns the Girke API service identity and configured version.',
      responses: {
        200: {
          description: 'Service identity metadata.',
          content: {
            'application/json': {
              schema: rootResponseSchema,
              example: {
                name: 'api',
                internal: 'girke-api',
                version
              }
            }
          }
        }
      }
    }),
    (c) => c.json({ name: 'api', internal: 'girke-api', version }, 200)
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      operationId: 'getHealth',
      tags: ['System'],
      summary: 'Get health status',
      description: 'Returns a lightweight public health check.',
      responses: {
        200: {
          description: 'Healthy service response.',
          content: {
            'application/json': {
              schema: healthResponseSchema,
              example: { ok: true }
            }
          }
        }
      }
    }),
    (c) => c.json({ ok: true }, 200)
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/version',
      operationId: 'getVersion',
      tags: ['System'],
      summary: 'Get deployed version',
      description: 'Returns the configured runtime version string.',
      responses: {
        200: {
          description: 'Configured version response.',
          content: {
            'application/json': {
              schema: versionResponseSchema,
              example: { version }
            }
          }
        }
      }
    }),
    (c) => c.json({ version }, 200)
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: OPENAPI_DOCUMENT_PATH,
      operationId: 'getOpenApiDocument',
      tags: ['API Reference'],
      summary: 'Get OpenAPI JSON',
      description: 'Returns the public OpenAPI 3.1 document generated from runtime route metadata.',
      responses: {
        200: {
          description: 'OpenAPI document JSON.',
          content: {
            'application/json': {
              schema: openApiDocumentSchema,
              example: {
                openapi: '3.1.0',
                info: openApiConfig.info,
                tags: openApiConfig.tags,
                paths: {
                  '/': {},
                  '/health': {},
                  '/version': {},
                  [OPENAPI_DOCUMENT_PATH]: {},
                  [API_REFERENCE_PATH]: {}
                },
                components: openApiConfig.components
              }
            }
          }
        }
      }
    }),
    (c) => c.json(app.getOpenAPI31Document(openApiConfig), 200)
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: API_REFERENCE_PATH,
      operationId: 'getApiReference',
      tags: ['API Reference'],
      summary: 'Get Scalar API Reference',
      description: 'Returns the public Scalar HTML shell backed by the OpenAPI JSON document.',
      responses: {
        200: {
          description: 'Scalar API Reference HTML.',
          content: {
            'text/html': {
              schema: scalarHtmlSchema
            }
          }
        }
      }
    }),
    async (c) => {
      const response = await scalarReference(c, async () => undefined)
      return response ?? c.html('', 200)
    }
  )
}

export { API_REFERENCE_PATH, BEARER_SECURITY_SCHEME, OPENAPI_DOCUMENT_PATH }
