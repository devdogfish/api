import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import type { AppEnv } from '../appEnv'
import {
  API_DESCRIPTION,
  API_INTERNAL_NAME,
  API_NAME,
  API_REFERENCE_PAGE_TITLE,
  API_REFERENCE_PATH,
  API_REFERENCE_TAG,
  API_TITLE,
  BEARER_SECURITY_SCHEME,
  createOpenApiDocumentConfig,
  OONA_CONTACT_TAG,
  OPENAPI_DOCUMENT_PATH,
  OPENAPI_VERSION,
  SYSTEM_TAG
} from '../openapi'

const VERSION_EXAMPLE = 'test-version'
const SCALAR_HTML_EXAMPLE = '<!doctype html><html></html>'
const HEALTH_RESPONSE = { ok: true } as const
const noopNext = async () => undefined

const rootResponseSchema = z
  .object({
    name: z.string().openapi({ example: API_NAME }),
    internal: z.string().openapi({ example: API_INTERNAL_NAME }),
    version: z.string().openapi({ example: VERSION_EXAMPLE })
  })
  .openapi('ApiRootResponse')

const healthResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: HEALTH_RESPONSE.ok })
  })
  .openapi('HealthResponse')

const versionResponseSchema = z
  .object({
    version: z.string().openapi({ example: VERSION_EXAMPLE })
  })
  .openapi('VersionResponse')

const openApiInfoSchema = z.object({
  title: z.string().openapi({ example: API_TITLE }),
  version: z.string().openapi({ example: VERSION_EXAMPLE }),
  description: z.string().openapi({ example: API_DESCRIPTION }).optional()
})

const openApiTagSchema = z.object({
  name: z.string(),
  description: z.string().optional()
})

const openApiComponentsSchema = z
  .object({
    securitySchemes: z.record(z.string(), z.any()).optional()
  })
  .catchall(z.any())

const openApiDocumentSchema = z
  .object({
    openapi: z.string().openapi({ example: OPENAPI_VERSION }),
    info: openApiInfoSchema,
    tags: z
      .array(openApiTagSchema)
      .openapi({
        example: [SYSTEM_TAG, API_REFERENCE_TAG, OONA_CONTACT_TAG]
      })
      .optional(),
    paths: z.record(z.string(), z.any()).optional(),
    components: openApiComponentsSchema.optional()
  })
  .openapi('OpenApiDocument')

const scalarHtmlSchema = z.string().openapi({ example: SCALAR_HTML_EXAMPLE }).openapi('ScalarHtmlDocument')

type StaticJsonResponse =
  | ReturnType<typeof createRootResponse>
  | ReturnType<typeof createVersionResponse>
  | typeof HEALTH_RESPONSE

type StaticJsonSchema = typeof rootResponseSchema | typeof healthResponseSchema | typeof versionResponseSchema

type StaticJsonRouteDefinition = {
  path: string
  operationId: string
  tag: string
  summary: string
  description: string
  responseDescription: string
  schema: StaticJsonSchema
  responseBody: StaticJsonResponse
}

function createRootResponse(version: string) {
  return {
    name: API_NAME,
    internal: API_INTERNAL_NAME,
    version
  }
}

function createVersionResponse(version: string) {
  return { version }
}

function createJsonContent(schema: StaticJsonSchema | typeof openApiDocumentSchema, example: unknown) {
  return {
    'application/json': {
      schema,
      example
    }
  }
}

function registerStaticJsonRoute(app: OpenAPIHono<AppEnv>, route: StaticJsonRouteDefinition) {
  app.openapi(
    createRoute({
      method: 'get',
      path: route.path,
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      description: route.description,
      responses: {
        200: {
          description: route.responseDescription,
          content: createJsonContent(route.schema, route.responseBody)
        }
      }
    }),
    (c) => c.json(route.responseBody, 200)
  )
}

export function registerSystemRoutes(app: OpenAPIHono<AppEnv>, version: string) {
  const openApiConfig = createOpenApiDocumentConfig(version)
  const scalarReference = Scalar<AppEnv>({
    pageTitle: API_REFERENCE_PAGE_TITLE,
    url: OPENAPI_DOCUMENT_PATH
  })
  const bearerSecurityScheme = openApiConfig.components.securitySchemes[BEARER_SECURITY_SCHEME]
  const rootResponse = createRootResponse(version)
  const versionResponse = createVersionResponse(version)
  const openApiDocumentExample = {
    openapi: OPENAPI_VERSION,
    info: openApiConfig.info,
    tags: openApiConfig.tags,
    paths: {
      '/': {},
      '/api/v1/oona/contact': {},
      '/health': {},
      '/version': {},
      [OPENAPI_DOCUMENT_PATH]: {},
      [API_REFERENCE_PATH]: {}
    },
    components: openApiConfig.components
  }

  app.openAPIRegistry.registerComponent('securitySchemes', BEARER_SECURITY_SCHEME, bearerSecurityScheme)

  registerStaticJsonRoute(app, {
    path: '/',
    operationId: 'getApiRoot',
    tag: SYSTEM_TAG.name,
    summary: 'Get API service metadata',
    description: 'Returns the Girke API service identity and configured version.',
    responseDescription: 'Service identity metadata.',
    schema: rootResponseSchema,
    responseBody: rootResponse
  })

  registerStaticJsonRoute(app, {
    path: '/health',
    operationId: 'getHealth',
    tag: SYSTEM_TAG.name,
    summary: 'Get health status',
    description: 'Returns a lightweight public health check.',
    responseDescription: 'Healthy service response.',
    schema: healthResponseSchema,
    responseBody: HEALTH_RESPONSE
  })

  registerStaticJsonRoute(app, {
    path: '/version',
    operationId: 'getVersion',
    tag: SYSTEM_TAG.name,
    summary: 'Get deployed version',
    description: 'Returns the configured runtime version string.',
    responseDescription: 'Configured version response.',
    schema: versionResponseSchema,
    responseBody: versionResponse
  })

  app.openapi(
    createRoute({
      method: 'get',
      path: OPENAPI_DOCUMENT_PATH,
      operationId: 'getOpenApiDocument',
      tags: [API_REFERENCE_TAG.name],
      summary: 'Get OpenAPI JSON',
      description: 'Returns the public OpenAPI 3.1 document generated from runtime route metadata.',
      responses: {
        200: {
          description: 'OpenAPI document JSON.',
          content: createJsonContent(openApiDocumentSchema, openApiDocumentExample)
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
      tags: [API_REFERENCE_TAG.name],
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
      const response = await scalarReference(c, noopNext)
      return response ?? c.html('', 200)
    }
  )
}

export { API_REFERENCE_PATH, BEARER_SECURITY_SCHEME, OPENAPI_DOCUMENT_PATH }
