import { Hono } from 'hono'

export function feedRoutes() {
  const app = new Hono()

  app.get('/', (c) => c.json({ feeds: [] }))

  return app
}
