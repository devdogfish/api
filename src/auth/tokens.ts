import { createHash, randomBytes } from 'node:crypto'

const TOKEN_PREFIX = 'girke_'

export function generateApiToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function isGirkeApiToken(token: string) {
  return token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length
}

export function hashApiToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
