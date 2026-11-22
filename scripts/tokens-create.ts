import { generateApiToken, hashApiToken } from '../src/auth/tokens'

const args = Bun.argv.slice(2)
const scopes: string[] = []
const nameParts: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--scope' && args[i + 1]) scopes.push(args[++i])
  else nameParts.push(args[i])
}
const name = nameParts.join(' ').trim()

if (!name) {
  console.error('Usage: bun run tokens:create <name> [--scope llm]')
  process.exit(1)
}

const [{ db, sql }, { apiTokens }] = await Promise.all([import('../src/db/client'), import('../src/db/schema')])

try {
  const token = generateApiToken()
  const [created] = await db
    .insert(apiTokens)
    .values({ name, tokenHash: hashApiToken(token), scopes })
    .returning({ id: apiTokens.id, name: apiTokens.name, createdAt: apiTokens.createdAt })

  console.log(JSON.stringify({ id: created.id, name: created.name, scopes, token, created_at: created.createdAt.toISOString() }, null, 2))
} finally {
  await sql.end()
}
