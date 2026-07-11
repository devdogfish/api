import type { MiddlewareHandler } from 'hono'

export type ApiTokenPrincipal = {
  id: number
  name: string
}

export type AuthVariables = {
  apiToken: ApiTokenPrincipal
}

export type ApiTokenStore = {
  findActiveByToken(token: string): Promise<ApiTokenPrincipal | null>
}

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export function bearerTokenAuth(tokenStore: ApiTokenStore): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const presented = parseBearerToken(c.req.header('Authorization'))
    if (!presented) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const apiToken = await tokenStore.findActiveByToken(presented)
    if (!apiToken) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    c.set('apiToken', apiToken)
    await next()
  }
}
