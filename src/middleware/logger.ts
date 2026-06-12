import type { MiddlewareHandler } from 'hono'

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now()
    await next()
    console.log(JSON.stringify({
      level: 'info',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms: Date.now() - start
    }))
  }
}
