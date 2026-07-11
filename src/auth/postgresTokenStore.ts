import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { apiTokens } from '../db/schema'
import type { ApiTokenStore } from '../middleware/auth'
import { hashApiToken, isGirkeApiToken } from './tokens'

export function createPostgresApiTokenStore(database = db): ApiTokenStore {
  return {
    async findActiveByToken(token) {
      if (!isGirkeApiToken(token)) return null

      const [apiToken] = await database
        .select({ id: apiTokens.id, name: apiTokens.name })
        .from(apiTokens)
        .where(and(eq(apiTokens.tokenHash, hashApiToken(token)), isNull(apiTokens.revokedAt)))
        .limit(1)

      return apiToken ?? null
    }
  }
}
