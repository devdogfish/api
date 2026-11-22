import type { MiddlewareHandler } from 'hono'
import { FORBIDDEN_ERROR_BODY, UNAUTHORIZED_ERROR_BODY } from '../openapi'

export type ApiTokenPrincipal = {
  id: number
  name: string
  scopes?: string[]
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

export function requireScope(scope: string): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (!c.get('apiToken').scopes?.includes(scope)) return c.json(FORBIDDEN_ERROR_BODY, 403)
    await next()
  }
}

export function bearerTokenAuth(tokenStore: ApiTokenStore): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const presented = parseBearerToken(c.req.header('Authorization'))
    if (!presented) {
      return c.json(UNAUTHORIZED_ERROR_BODY, 401)
    }

    const apiToken = await tokenStore.findActiveByToken(presented)
    if (!apiToken) {
      return c.json(UNAUTHORIZED_ERROR_BODY, 401)
    }

    c.set('apiToken', apiToken)
    await next()
  }
}
