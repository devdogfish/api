import type { ApiTokenStore } from '../src/middleware/auth'

export const testToken = 'girke_valid'
export const authHeaders = { Authorization: `Bearer ${testToken}` }

export function testApiTokenStore(activeToken = testToken, scopes: string[] = []): ApiTokenStore {
  return {
    async findActiveByToken(token) {
      return token === activeToken ? { id: 12, name: 'test-token', scopes } : null
    }
  }
}
