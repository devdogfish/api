import type { MiddlewareHandler } from 'hono'

export function apiKeyAuth(apiKey: string): MiddlewareHandler {
  return async (c, next) => {
    const presented = c.req.header('X-API-Key')
    if (!presented || presented !== apiKey) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
}
