import { describe, expect, it } from 'vitest'
import { mintSessionViaSiwe } from '../src/session.js'

/**
 * Programmatic login, so a process can hold its own session instead of copying one
 * out of a browser.
 *
 * The venue publishes no API keys -- its trading API is documented as unavailable to
 * any user -- so the only programmatic way in is the same SIWE handshake the web app
 * performs. An existing account's login carries no captcha (the Turnstile gate is on
 * new-account creation), so this is the ordinary login path, not a way around one.
 *
 * The order below is the contract: the message MUST be round-tripped from the venue and
 * never synthesised locally, because it carries a server-chosen nonce. Signing a
 * locally-built message produces a valid signature over the wrong text, which the venue
 * rejects with no useful diagnostic.
 */
type Call = { name: string; args: unknown }

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = []
  const client = {
    async generateSigningData(address: string) {
      calls.push({ name: 'generateSigningData', args: address })
      return 'omni.variational.io wants you to sign in\nNonce: server-chosen-42'
    },
    async login(args: { address: string; signedMessage: string }) {
      calls.push({ name: 'login', args })
      return { token: 'jwt.from.venue' }
    },
    cookies: { serialize: () => 'vr-token=abc; other=def' },
    ...overrides,
  }
  return { client, calls }
}

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'

describe('mintSessionViaSiwe', () => {
  it('round-trips the venue-issued message rather than inventing one', async () => {
    const { client, calls } = fakeClient()
    await mintSessionViaSiwe(client as never, KEY)
    expect(calls.map((c) => c.name)).toEqual(['generateSigningData', 'login'])
  })

  it('signs as the address derived from the key, and tells the venue that address', async () => {
    const { client, calls } = fakeClient()
    const bundle = await mintSessionViaSiwe(client as never, KEY)
    const login = calls.find((c) => c.name === 'login')?.args as { address: string }
    expect(login.address.toLowerCase()).toBe('0x2c7536e3605d9c16a7a3d7b1898e529396a65c23')
    expect(bundle.address?.toLowerCase()).toBe(login.address.toLowerCase())
  })

  it('returns the venue token and the cookies the login established', async () => {
    const { client } = fakeClient()
    const bundle = await mintSessionViaSiwe(client as never, KEY)
    expect(bundle.token).toBe('jwt.from.venue')
    expect(bundle.cookies).toBe('vr-token=abc; other=def')
  })

  it('refuses a key that is not a key, before touching the network', async () => {
    const { client, calls } = fakeClient()
    await expect(mintSessionViaSiwe(client as never, 'not-a-key')).rejects.toThrow(/32 bytes/i)
    expect(calls).toEqual([])
  })

  it('fails loudly when the venue returns no token', async () => {
    const { client } = fakeClient({ login: async () => ({ token: '' }) })
    await expect(mintSessionViaSiwe(client as never, KEY)).rejects.toThrow(/no token/i)
  })
})

import { CookieJar } from '../src/http.js'

describe('mintSessionViaSiwe against the real cookie jar', () => {
  /*
   * The fake above has always had a `serialize`; the real CookieJar did not, and the
   * production callers cast the client to `never` to get past the type error. So the
   * one path that renews an expired session on the VPS threw a TypeError every time.
   * This pins the real jar to the contract the function actually calls.
   */
  it('serialises the jar into the bundle instead of throwing', () => {
    const jar = new CookieJar()
    jar.absorb(['vr-token=abc; Path=/', 'other=def; Path=/'])
    expect(jar.serialize()).toContain('vr-token=abc')
    expect(jar.serialize()).toContain('other=def')
  })

  it('serialises an empty jar to an empty string, not undefined', () => {
    expect(new CookieJar().serialize()).toBe('')
  })
})
