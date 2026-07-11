import { describe, expect, test } from 'bun:test'
import { generateApiToken, hashApiToken, isGirkeApiToken } from '../src/auth/tokens'

describe('Girke API tokens', () => {
  test('generates one-time bearer token values in the girke_ format', () => {
    const token = generateApiToken()

    expect(token.startsWith('girke_')).toBe(true)
    expect(isGirkeApiToken(token)).toBe(true)
    expect(token.length).toBeGreaterThan(40)
  })

  test('hashes token values without preserving the raw credential', () => {
    const token = 'girke_test-token'

    const hash = hashApiToken(token)

    expect(hash).not.toContain(token)
    expect(hash).toBe(hashApiToken(token))
    expect(hash).not.toBe(hashApiToken('girke_other-token'))
  })
})
