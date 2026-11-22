import { and, eq, isNull, sql as rawSql } from 'drizzle-orm'

const [id, action, scope] = [Number(Bun.argv[2]), Bun.argv[3], Bun.argv[4]]

if (!Number.isInteger(id) || id <= 0 || !['grant', 'revoke'].includes(action) || !scope) {
  console.error('Usage: bun run tokens:scope <id> grant|revoke <scope>')
  process.exit(1)
}

const [{ db, sql }, { apiTokens }] = await Promise.all([import('../src/db/client'), import('../src/db/schema')])

try {
  const next =
    action === 'grant'
      ? rawSql`(SELECT ARRAY(SELECT DISTINCT unnest(${apiTokens.scopes} || ARRAY[${scope}]::text[])))`
      : rawSql`array_remove(${apiTokens.scopes}, ${scope})`
  const [updated] = await db
    .update(apiTokens)
    .set({ scopes: next })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes })

  if (!updated) {
    console.error(JSON.stringify({ error: 'api_token_not_found_or_revoked' }))
    process.exit(1)
  }
  console.log(JSON.stringify(updated, null, 2))
} finally {
  await sql.end()
}
