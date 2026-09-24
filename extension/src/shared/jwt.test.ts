import { describe, expect, it } from 'vitest'
import { decodeJwtClaims } from './jwt.js'

function b64url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function jwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.signature`
}

describe('decodeJwtClaims', () => {
  it('reads address, exp and a string scope', () => {
    const token = jwt({ address: '0xAbC', exp: 1_800_000_000, scope: 'transfer:none' })
    expect(decodeJwtClaims(token)).toEqual({
      address: '0xAbC',
      exp: 1_800_000_000,
      scope: 'transfer:none',
    })
  })

  it('joins an array scope, since tokens carry either form', () => {
    const token = jwt({ scope: ['transfer:none', 'trade'] })
    expect(decodeJwtClaims(token).scope).toBe('transfer:none trade')
  })

  it('returns null claims rather than throwing on garbage', () => {
    const empty = { address: null, exp: null, scope: null }
    expect(decodeJwtClaims('')).toEqual(empty)
    expect(decodeJwtClaims('not-a-jwt')).toEqual(empty)
    expect(decodeJwtClaims('a.b')).toEqual(empty)
    expect(decodeJwtClaims('a.!!!!.c')).toEqual(empty)
    expect(decodeJwtClaims(`a.${b64url('not json')}.c`)).toEqual(empty)
    expect(decodeJwtClaims(`a.${b64url('[1,2,3]')}.c`)).toEqual(empty)
  })

  it('ignores claims of the wrong type', () => {
    const token = jwt({ address: 42, exp: 'soon', scope: { a: 1 } })
    expect(decodeJwtClaims(token)).toEqual({ address: null, exp: null, scope: null })
  })

  it('handles a payload with non-ASCII characters and no base64 padding', () => {
    const token = jwt({ address: '0xé', exp: 1 })
    expect(decodeJwtClaims(token).address).toBe('0xé')
  })

  it('treats an empty scope string as absent', () => {
    expect(decodeJwtClaims(jwt({ scope: '   ' })).scope).toBeNull()
    expect(decodeJwtClaims(jwt({ scope: [] })).scope).toBeNull()
  })
})
