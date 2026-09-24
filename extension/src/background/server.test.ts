import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSessionBundle } from '../shared/bundle.js'
import type { ServerTarget } from '../shared/settings.js'
import { pushSession } from './server.js'

const TARGET: ServerTarget = {
  base: 'https://bot.example.com/api',
  originPattern: 'https://bot.example.com/*',
  origin: 'https://bot.example.com',
  loopback: false,
}

const BUNDLE = buildSessionBundle('a.b.c', [])

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    impl(String(input), init ?? {}),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pushSession', () => {
  it('POSTs the bundle itself to {base}/session with the bearer token and no cookies', async () => {
    const spy = stubFetch(async () => json({ ok: true }))
    const result = await pushSession(TARGET, 'secret-token', BUNDLE)

    expect(result.kind).toBe('ok')
    const [url, init] = spy.mock.calls[0] ?? []
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(url).toBe('https://bot.example.com/api/session')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('omit')
    expect(headers['authorization']).toBe('Bearer secret-token')
    expect(headers['content-type']).toBe('application/json')
    // The body is the session.json format, not wrapped in an envelope.
    expect(JSON.parse(String(init?.body))).toEqual(BUNDLE)
  })

  it('never puts the token in the URL', async () => {
    const spy = stubFetch(async () => json({ ok: true }))
    await pushSession(TARGET, 'secret-token', BUNDLE)
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('secret-token')
  })

  it('accepts a 2xx with an empty body', async () => {
    stubFetch(async () => new Response(null, { status: 204 }))
    expect((await pushSession(TARGET, 't', BUNDLE)).kind).toBe('ok')
  })

  it('surfaces an explicit { ok: false } rejection', async () => {
    stubFetch(async () => json({ ok: false, error: 'wrong account' }))
    const result = await pushSession(TARGET, 't', BUNDLE)
    expect(result.kind).toBe('http')
    expect(result.kind === 'http' && result.detail).toBe('wrong account')
  })

  it('maps 401 and 403 to unauthorized', async () => {
    for (const status of [401, 403]) {
      stubFetch(async () => json({}, status))
      expect((await pushSession(TARGET, 't', BUNDLE)).kind).toBe('unauthorized')
    }
  })

  it('maps other non-2xx to http and keeps a bounded excerpt of the body', async () => {
    stubFetch(async () => new Response(`server on fire ${'x'.repeat(500)}`, { status: 500 }))
    const result = await pushSession(TARGET, 't', BUNDLE)
    expect(result.kind).toBe('http')
    if (result.kind !== 'http') return
    expect(result.detail).toContain('server on fire')
    expect(result.detail.length).toBeLessThan(250)
  })

  it('maps a transport failure to network', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect((await pushSession(TARGET, 't', BUNDLE)).kind).toBe('network')
  })
})
