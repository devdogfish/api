import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../appEnv'
import { FEEDS_TAG, PROTECTED_BEARER_SECURITY, unauthorizedErrorResponse } from '../openapi'

const feedsResponseExample = { feeds: [] } as const

const feedsResponseSchema = z
  .object({
    feeds: z.array(z.record(z.string(), z.unknown())).openapi({ example: feedsResponseExample.feeds })
  })
  .openapi('FeedsResponse')

export function feedRoutes() {
  const app = new OpenAPIHono<AppEnv>()

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      operationId: 'listFeeds',
      tags: [FEEDS_TAG.name],
      summary: 'List feeds',
      description: 'Returns the current feed list for the authenticated API Token.',
      security: PROTECTED_BEARER_SECURITY,
      responses: {
        200: {
          description: 'Current feed list.',
          content: {
            'application/json': {
              schema: feedsResponseSchema,
              example: feedsResponseExample
            }
          }
        },
        401: unauthorizedErrorResponse
      }
    }),
    (c) => c.json(feedsResponseExample)
  )

  return app
}
