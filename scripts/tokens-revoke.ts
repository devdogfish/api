import { and, eq, isNull } from 'drizzle-orm'

const id = Number(Bun.argv[2])

if (!Number.isInteger(id) || id <= 0) {
  console.error('Usage: bun run tokens:revoke <id>')
  process.exit(1)
}

const [{ db, sql }, { apiTokens }] = await Promise.all([import('../src/db/client'), import('../src/db/schema')])

try {
  const [revoked] = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id, name: apiTokens.name, revokedAt: apiTokens.revokedAt })

  if (!revoked) {
    console.error(JSON.stringify({ error: 'api_token_not_found_or_already_revoked' }))
    process.exit(1)
  }

  console.log(JSON.stringify({ id: revoked.id, name: revoked.name, revoked_at: revoked.revokedAt?.toISOString() }, null, 2))
} finally {
  await sql.end()
}
