import { generateApiToken, hashApiToken } from '../src/auth/tokens'

const name = Bun.argv.slice(2).join(' ').trim()

if (!name) {
  console.error('Usage: bun run tokens:create <name>')
  process.exit(1)
}

const [{ db, sql }, { apiTokens }] = await Promise.all([import('../src/db/client'), import('../src/db/schema')])

try {
  const token = generateApiToken()
  const [created] = await db
    .insert(apiTokens)
    .values({ name, tokenHash: hashApiToken(token) })
    .returning({ id: apiTokens.id, name: apiTokens.name, createdAt: apiTokens.createdAt })

  console.log(JSON.stringify({ id: created.id, name: created.name, token, created_at: created.createdAt.toISOString() }, null, 2))
} finally {
  await sql.end()
}
