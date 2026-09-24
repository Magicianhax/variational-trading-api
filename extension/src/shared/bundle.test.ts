import { describe, expect, it } from 'vitest'
// Type-only import of the client library's format: erased at runtime, checked by tsc.
import type { SessionBundle as ClientSessionBundle } from '../../../src/session-bundle.js'
import {
  buildSessionBundle,
  fingerprintBundle,
  fingerprintInput,
  type SessionBundle,
  serializeBundle,
} from './bundle.js'
import { type RawCookie, selectSessionCookies } from './cookies.js'

function b64url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const ADDRESS = '0x00000000000000000000000000000000000000Aa'
const TOKEN = `h.${b64url(JSON.stringify({ address: ADDRESS, exp: 1_800_000_000, scope: 'transfer:none' }))}.s`

function cookie(name: string, value: string, overrides: Partial<RawCookie> = {}): RawCookie {
  return {
    name,
    value,
    domain: '.variational.io',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    sameSite: 'lax',
    expirationDate: 1_800_000_000,
    ...overrides,
  }
}

// Compile-time drift guard: the exported bundle must be assignable to the client's
// type, and the two must name exactly the same fields.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false
const keysMatch: SameKeys<SessionBundle, ClientSessionBundle> = true
const asClient = (bundle: SessionBundle): ClientSessionBundle => bundle

describe('buildSessionBundle', () => {
  const jar = selectSessionCookies([
    cookie('vr-token', 'abc'),
    cookie('vr-connected-address', 'def'),
    cookie('_ga', 'GA1.2.3'),
    cookie('cf_clearance', 'cf-value'),
    cookie('__cf_bm', 'bm-value'),
  ])
  const bundle = buildSessionBundle(TOKEN, jar)

  it('has exactly the client SessionBundle fields, in a stable order', () => {
    expect(keysMatch).toBe(true)
    expect(asClient(bundle)).toBe(bundle)
    expect(Object.keys(bundle)).toEqual(['token', 'cookies', 'address', 'expiresAt'])
  })

  it('carries the /me token verbatim', () => {
    expect(bundle.token).toBe(TOKEN)
  })

  it('serialises cookies as a Cookie header, without analytics or Cloudflare cookies', () => {
    expect(bundle.cookies).toBe('vr-connected-address=def; vr-token=abc')
    const text = serializeBundle(bundle)
    for (const leaked of ['GA1.2.3', 'cf-value', 'bm-value', '_ga', 'cf_clearance', '__cf_bm']) {
      expect(text).not.toContain(leaked)
    }
  })

  it('keeps the address exactly as the venue wrote it', () => {
    expect(bundle.address).toBe(ADDRESS)
  })

  it('converts the JWT exp from seconds to epoch milliseconds', () => {
    expect(bundle.expiresAt).toBe(1_800_000_000_000)
  })

  it('never fills in the user agent', () => {
    expect('userAgent' in bundle).toBe(false)
  })

  it('omits claims the token does not carry instead of writing undefined or null', () => {
    const opaque = buildSessionBundle('opaque-token', [])
    expect(opaque).toEqual({ token: 'opaque-token', cookies: '' })
    expect(Object.keys(opaque)).toEqual(['token', 'cookies'])
  })
})

describe('serializeBundle', () => {
  it('round-trips through JSON.parse to the same bundle', () => {
    const bundle = buildSessionBundle(TOKEN, [cookie('vr-token', 'abc')])
    const text = serializeBundle(bundle)
    expect(JSON.parse(text)).toEqual(bundle)
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('fingerprint', () => {
  it('ignores cookie ordering once the jar has been selected', () => {
    const a = buildSessionBundle(TOKEN, selectSessionCookies([cookie('a', '1'), cookie('b', '2')]))
    const b = buildSessionBundle(TOKEN, selectSessionCookies([cookie('b', '2'), cookie('a', '1')]))
    expect(fingerprintInput(a)).toBe(fingerprintInput(b))
  })

  it('changes when the token changes', () => {
    const a = buildSessionBundle(TOKEN, [cookie('vr-token', 'abc')])
    const b = buildSessionBundle(`${TOKEN}x`, [cookie('vr-token', 'abc')])
    expect(fingerprintInput(a)).not.toBe(fingerprintInput(b))
  })

  it('changes when a cookie value changes', () => {
    const a = buildSessionBundle(TOKEN, [cookie('vr-token', 'abc')])
    const b = buildSessionBundle(TOKEN, [cookie('vr-token', 'abd')])
    expect(fingerprintInput(a)).not.toBe(fingerprintInput(b))
  })

  it('hashes to a stable 64-char hex digest', async () => {
    const a = buildSessionBundle(TOKEN, [cookie('vr-token', 'abc')])
    const digest = await fingerprintBundle(a)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(await fingerprintBundle(a)).toBe(digest)
  })

  it('never embeds the raw credential in the digest', async () => {
    const a = buildSessionBundle(TOKEN, [cookie('vr-token', 'super-secret')])
    const digest = await fingerprintBundle(a)
    expect(digest).not.toContain('super-secret')
    expect(digest).not.toContain(TOKEN.slice(0, 10))
  })
})
