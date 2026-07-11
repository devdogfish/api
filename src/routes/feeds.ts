import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../appEnv'
import { createJsonResponse, FEEDS_TAG, PROTECTED_BEARER_SECURITY, unauthorizedErrorResponse } from '../openapi'

const feedsResponseExample = { feeds: [] } as const

const feedsResponseSchema = z
  .object({
    feeds: z.array(z.record(z.string(), z.unknown())).openapi({ example: feedsResponseExample.feeds })
  })
  .openapi('FeedsResponse')

const listFeedsRoute = createRoute({
  method: 'get',
  path: '/',
  operationId: 'listFeeds',
  tags: [FEEDS_TAG.name],
  summary: 'List feeds',
  description: 'Returns the current feed list for the authenticated API Token.',
  security: PROTECTED_BEARER_SECURITY,
  responses: {
    200: createJsonResponse('Current feed list.', feedsResponseSchema, feedsResponseExample),
    401: unauthorizedErrorResponse
  }
})

export function feedRoutes() {
  const app = new OpenAPIHono<AppEnv>()

  app.openapi(listFeedsRoute, (c) => c.json(feedsResponseExample))

  return app
}
