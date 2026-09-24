import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OmniClient } from '../src/client.js'
import type { SessionBundle } from '../src/session-bundle.js'
import { cleanCookieHeader, loadSession } from '../src/session-io.js'
import { FakeFetch, headerOf } from './helpers.js'

/**
 * A session reaches the client in whatever form a person holds it: a file, pasted JSON,
 * or a header copied out of DevTools. These pin the forms, the cleaning, and -- because
 * the input is a credential -- that no error message ever repeats a secret back.
 */

/** Unsigned JWT: the client never verifies signatures, it only reads `exp`. */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`
}

const SESSION_COOKIES = 'vr-token=abc123; vr-connected-address=0xdead'

describe('cleanCookieHeader', () => {
  it('strips a leading "cookie:" label in any case', () => {
    expect(cleanCookieHeader('cookie: vr-token=abc')).toBe('vr-token=abc')
    expect(cleanCookieHeader('Cookie:vr-token=abc')).toBe('vr-token=abc')
  })

  it('drops Cloudflare cookies, which are bound to the browser that earned them', () => {
    const header =
      '__cf_bm=x; vr-token=abc; _cfuvid=y; cf_clearance=z; cf_chl_rc=q; __cflb=w; vr-other=1'
    expect(cleanCookieHeader(header)).toBe('vr-token=abc; vr-other=1')
  })

  it('drops analytics cookies and keeps everything else in order', () => {
    const header = [
      '_ga=1',
      '_ga_ABC123=2',
      '_gid=3',
      '_gat_UA=4',
      '_fbp=5',
      '_fbc=6',
      '_dd_s=7',
      '_uetsid=8',
      '_uetvid=9',
      'ajs_anonymous_id=10',
      'amplitude_id_x=11',
      'intercom-session-abc=12',
      '_hjSessionUser=13',
      'mp_abc_mixpanel=14',
      'vr-token=abc',
      'locale=en',
    ].join('; ')
    expect(cleanCookieHeader(header)).toBe('vr-token=abc; locale=en')
  })

  it('keeps "=" inside a value and tolerates quotes, stray separators and newlines', () => {
    expect(cleanCookieHeader('"cookie: vr-token=a=b==;; junk; \n vr-x=1;"')).toBe(
      'vr-token=a=b==; vr-x=1',
    )
  })

  it('returns an empty string when nothing survives', () => {
    expect(cleanCookieHeader('cookie: __cf_bm=x; _ga=1')).toBe('')
    expect(cleanCookieHeader('')).toBe('')
  })
})

describe('loadSession', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-io-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('treats a raw Cookie header as a session with no token yet', () => {
    const bundle = loadSession(`Cookie: __cf_bm=x; ${SESSION_COOKIES}; _ga=1`)
    expect(bundle).toEqual({ token: '', cookies: SESSION_COOKIES })
  })

  it('parses a JSON string and cleans its cookies', () => {
    const json = JSON.stringify({
      token: '',
      cookies: `${SESSION_COOKIES}; cf_clearance=z`,
      address: '0xabc',
      userAgent: 'UA/1',
      expiresAt: 123,
    })
    expect(loadSession(`  ${json}\n`)).toEqual({
      token: '',
      cookies: SESSION_COOKIES,
      address: '0xabc',
      userAgent: 'UA/1',
      expiresAt: 123,
    })
  })

  it('reads a session.json file from a path', () => {
    const path = join(dir, 'session.json')
    writeFileSync(path, JSON.stringify({ token: 'tok', cookies: SESSION_COOKIES }))
    expect(loadSession(path)).toEqual({ token: 'tok', cookies: SESSION_COOKIES })
  })

  it('passes an object through, cleaned, without mutating the caller', () => {
    const input: SessionBundle = { token: 'tok', cookies: `_gid=3; ${SESSION_COOKIES}` }
    expect(loadSession(input)).toEqual({ token: 'tok', cookies: SESSION_COOKIES })
    expect(input.cookies).toBe(`_gid=3; ${SESSION_COOKIES}`)
  })

  it('accepts a bundle with no token at all -- getMe() mints it from the cookies', () => {
    expect(loadSession(JSON.stringify({ cookies: SESSION_COOKIES }))).toEqual({
      token: '',
      cookies: SESSION_COOKIES,
    })
  })

  it('derives expiresAt from the JWT exp claim when the bundle has none', () => {
    const token = fakeJwt({ exp: 1_900_000_000, address: '0xabc' })
    expect(loadSession({ token, cookies: SESSION_COOKIES }).expiresAt).toBe(1_900_000_000_000)
  })

  it('keeps an explicit expiresAt over the JWT claim', () => {
    const token = fakeJwt({ exp: 1_900_000_000 })
    expect(loadSession({ token, cookies: SESSION_COOKIES, expiresAt: 5 }).expiresAt).toBe(5)
  })

  it('leaves expiresAt unset when the token is not a decodable JWT', () => {
    expect(loadSession({ token: 'opaque', cookies: SESSION_COOKIES }).expiresAt).toBeUndefined()
    expect(loadSession({ token: 'a.!!!.c', cookies: SESSION_COOKIES }).expiresAt).toBeUndefined()
  })

  describe('rejects unusable input with a clear message', () => {
    it.each([
      ['an empty string', ''],
      ['whitespace', '   '],
      ['a header with only Cloudflare and analytics cookies', '__cf_bm=x; _ga=1'],
      ['JSON with no cookies', '{"token":"t"}'],
      ['JSON whose cookies all get stripped', '{"token":"","cookies":"_ga=1"}'],
      ['JSON that is not an object', '{not json'],
      ['a non-string cookies field', '{"cookies":42}'],
      ['a missing file', join(dir, 'nope.json')],
    ])('%s', (_label, input) => {
      expect(() => loadSession(input)).toThrow(/No usable Variational session/)
    })

    it('a non-object bundle', () => {
      expect(() => loadSession(null as unknown as SessionBundle)).toThrow(/not a session object/)
      expect(() => loadSession('[1]' as string)).toThrow(/No usable Variational session/)
    })
  })

  it('never echoes a secret in an error', () => {
    // A plain marker rather than a JWT-shaped string: the check is that no input is echoed.
    const secret = 'SECRET-MARKER-SECRET-MARKER'
    const attempts = [
      secret,
      `{"cookies":"_ga=${secret}"`,
      `_ga=${secret}`,
      JSON.stringify({ token: secret, cookies: `__cf_bm=${secret}` }),
    ]
    for (const input of attempts) {
      let message = ''
      try {
        loadSession(input)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('SECRET')
    }
  })
})

describe('OmniClient.fromSession', () => {
  it('sends the cleaned session cookies and the bundle address on every request', async () => {
    const fake = new FakeFetch().always({ body: { token: '', intercomUserJwt: null } })
    const client = OmniClient.fromSession(
      JSON.stringify({ token: '', cookies: `__cf_bm=x; ${SESSION_COOKIES}`, address: '0xabc' }),
      { fetchImpl: fake.fetch, sleep: async () => {} },
    )
    await client.getMe()
    expect(headerOf(fake.last(), 'cookie')).toBe(SESSION_COOKIES)
    expect(headerOf(fake.last(), 'vr-connected-address')).toBe('0xabc')
  })

  it('carries a saved token so WebSocket auth works before the first getMe()', () => {
    const token = fakeJwt({ exp: 1_900_000_000 })
    const client = OmniClient.fromSession(
      { token, cookies: SESSION_COOKIES },
      { fetchImpl: new FakeFetch().fetch },
    )
    expect(client.getToken()).toBe(token)
    expect(client.cookies.get('vr-token')).toBe('abc123')
  })

  it('keeps dry run on by default', () => {
    const client = OmniClient.fromSession(SESSION_COOKIES, { fetchImpl: new FakeFetch().fetch })
    expect(client.dryRun).toBe(true)
  })

  it('throws before building a client when the session is unusable', () => {
    expect(() => OmniClient.fromSession('__cf_bm=x')).toThrow(/No usable Variational session/)
  })
})
