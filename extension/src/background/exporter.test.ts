import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawCookie } from '../shared/cookies.js'
import type { Settings } from '../shared/settings.js'
import { createFakeChrome, type FakeChrome } from '../test-support/fakeChrome.js'
import { runCycle } from './exporter.js'

const NOW = 1_800_000_000_000
const SERVER_ORIGIN_PATTERN = 'https://bot.example.com/*'
const OMNI_ORIGIN_PATTERN = 'https://omni.variational.io/*'
const ADDRESS = '0x00000000000000000000000000000000000000Aa'

function b64url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function makeToken(secondsFromNow: number, address = ADDRESS): string {
  const exp = Math.floor(NOW / 1000) + secondsFromNow
  return `h.${b64url(JSON.stringify({ address, exp, scope: 'transfer:none' }))}.s`
}

function cookie(name: string, value: string): RawCookie {
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
    expirationDate: Math.floor(NOW / 1000) + 86_400,
  }
}

interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface Router {
  me: () => Response
  session?: () => Response
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function challenge(): Response {
  return new Response('<html>Just a moment...</html>', {
    status: 403,
    headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
  })
}

function install(router: Router): Recorded[] {
  const recorded: Recorded[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      recorded.push({ url, method: init?.method ?? 'GET', headers, body })

      if (url === 'https://omni.variational.io/api/me') return router.me()
      if (url.endsWith('/session') && router.session !== undefined) return router.session()
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return recorded
}

const PUSH_SETTINGS: Settings = {
  pushEnabled: true,
  serverUrl: 'https://bot.example.com',
  serverToken: 'server-token',
  autoPush: true,
  refreshMinutes: 5,
}

let fake: FakeChrome

function setup(overrides: Parameters<typeof createFakeChrome>[0] = {}): void {
  fake?.uninstall()
  fake = createFakeChrome({
    grantedOrigins: [OMNI_ORIGIN_PATTERN],
    cookies: [
      cookie('vr-token', 'the-session'),
      cookie('_ga', 'GA1.2.3'),
      cookie('cf_clearance', 'cf-secret'),
      cookie('__cf_bm', 'bm-secret'),
    ],
    ...overrides,
  })
  fake.install()
}

function pushes(recorded: Recorded[]): Recorded[] {
  return recorded.filter((r) => r.url.endsWith('/session'))
}

beforeEach(() => {
  // Only Date is faked: token expiry is judged against a fixed clock, while
  // promises and AbortSignal timers keep running normally.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // The cycle logs pushes by design; keep the test output readable.
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  setup()
})

afterEach(() => {
  fake.uninstall()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('runCycle — export (push off, the default)', () => {
  it('returns the session bundle in the client format with only session cookies', async () => {
    const token = makeToken(3600)
    const recorded = install({ me: () => json({ token, intercomUserJwt: 'intercom-secret' }) })

    const { state, bundle } = await runCycle({ reason: 'popup-open', forcePush: false })

    expect(state.status.session.state).toBe('ok')
    expect(state.status.session.address).toBe(ADDRESS)
    expect(state.status.session.cookieCount).toBe(1)
    expect(state.status.session.droppedCookies).toEqual(['__cf_bm', '_ga', 'cf_clearance'])
    expect(bundle).toEqual({
      token,
      cookies: 'vr-token=the-session',
      address: ADDRESS,
      expiresAt: (Math.floor(NOW / 1000) + 3600) * 1000,
    })
    expect(JSON.stringify(bundle)).not.toContain('intercom-secret')
    expect(recorded.map((r) => r.url)).toEqual(['https://omni.variational.io/api/me'])
  })

  it('contacts no server and leaves the badge alone', async () => {
    const recorded = install({ me: () => json({ token: makeToken(3600) }) })
    const { state } = await runCycle({ reason: 'manual', forcePush: true })

    expect(state.status.push.state).toBe('off')
    expect(state.status.pendingPush).toBe(false)
    expect(pushes(recorded)).toHaveLength(0)
    expect(fake.badge.text).toBe('')
  })

  it('never writes the credential to storage — only its digest', async () => {
    const token = makeToken(3600)
    install({ me: () => json({ token }) })
    const { state } = await runCycle({ reason: 'manual', forcePush: false })

    const stored = JSON.stringify(fake.config.storage)
    expect(stored).not.toContain('the-session')
    expect(stored).not.toContain(token)
    expect(state.status.session.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports signed out and offers nothing to export', async () => {
    install({ me: () => json({ token: '' }) })
    const { state, bundle } = await runCycle({ reason: 'manual', forcePush: false })

    expect(state.status.session.state).toBe('absent')
    expect(state.status.session.detail).toContain('Signed out')
    expect(bundle).toBeNull()
  })

  it('treats a 401 from /api/me as signed out', async () => {
    install({ me: () => json({ error: 'unauthorized' }, 401) })
    const { state, bundle } = await runCycle({ reason: 'manual', forcePush: false })
    expect(state.status.session.state).toBe('absent')
    expect(bundle).toBeNull()
  })

  it('refuses to export an expired session', async () => {
    install({ me: () => json({ token: makeToken(-60) }) })
    const { state, bundle } = await runCycle({ reason: 'manual', forcePush: false })
    expect(state.status.session.state).toBe('expired')
    expect(bundle).toBeNull()
  })

  it('still exports a session inside the expiry warning window', async () => {
    install({ me: () => json({ token: makeToken(120) }) })
    const { state, bundle } = await runCycle({ reason: 'manual', forcePush: false })
    expect(state.status.session.state).toBe('expiring')
    expect(bundle).not.toBeNull()
  })

  it('reports a Cloudflare challenge as blocked with a way out', async () => {
    install({ me: () => challenge() })
    const { state, bundle } = await runCycle({ reason: 'manual', forcePush: false })
    expect(state.status.session.state).toBe('blocked')
    expect(state.status.session.detail).toContain('Re-check')
    expect(bundle).toBeNull()
  })

  it('reads nothing when venue host access has been revoked', async () => {
    setup({ grantedOrigins: [] })
    const recorded = install({ me: () => json({ token: makeToken(3600) }) })
    const { state, bundle } = await runCycle({ reason: 'manual', forcePush: false })

    expect(state.status.session.state).toBe('error')
    expect(state.omniHostGranted).toBe(false)
    expect(bundle).toBeNull()
    expect(recorded).toHaveLength(0)
  })
})

describe('runCycle — optional push', () => {
  beforeEach(() => {
    setup({
      grantedOrigins: [OMNI_ORIGIN_PATTERN, SERVER_ORIGIN_PATTERN],
      storage: { settings: PUSH_SETTINGS },
    })
  })

  it('POSTs the same bundle it exports, with the bearer token', async () => {
    const recorded = install({
      me: () => json({ token: makeToken(3600) }),
      session: () => json({ ok: true }),
    })
    const { state, bundle } = await runCycle({ reason: 'manual', forcePush: false })

    expect(state.status.push.state).toBe('ok')
    expect(state.status.pendingPush).toBe(false)
    const [push] = pushes(recorded)
    expect(push?.url).toBe('https://bot.example.com/session')
    expect(push?.method).toBe('POST')
    expect(push?.headers['authorization']).toBe('Bearer server-token')
    expect(push?.body).toEqual(bundle)
    expect(JSON.stringify(push?.body)).not.toContain('cf-secret')
  })

  it('does not push again while nothing changed', async () => {
    install({ me: () => json({ token: makeToken(3600) }), session: () => json({ ok: true }) })
    await runCycle({ reason: 'manual', forcePush: false })

    const second = install({
      me: () => json({ token: makeToken(3600) }),
      session: () => json({ ok: true }),
    })
    const { state } = await runCycle({ reason: 'alarm', forcePush: false })

    expect(pushes(second)).toHaveLength(0)
    expect(state.status.push.state).toBe('ok')
    expect(state.status.push.detail).toContain('already has')
  })

  it('pushes again once the session changes', async () => {
    install({ me: () => json({ token: makeToken(3600) }), session: () => json({ ok: true }) })
    await runCycle({ reason: 'manual', forcePush: false })

    const second = install({
      me: () => json({ token: makeToken(7200) }),
      session: () => json({ ok: true }),
    })
    await runCycle({ reason: 'cookie-change', forcePush: false })
    expect(pushes(second)).toHaveLength(1)
  })

  it('pushes again when pointed at a different server', async () => {
    install({ me: () => json({ token: makeToken(3600) }), session: () => json({ ok: true }) })
    await runCycle({ reason: 'manual', forcePush: false })

    fake.config.storage['settings'] = { ...PUSH_SETTINGS, serverUrl: 'https://bot.example.com/v2' }
    const second = install({
      me: () => json({ token: makeToken(3600) }),
      session: () => json({ ok: true }),
    })
    await runCycle({ reason: 'settings-change', forcePush: false })
    expect(pushes(second).map((r) => r.url)).toEqual(['https://bot.example.com/v2/session'])
  })

  it('"Push now" re-sends an unchanged session', async () => {
    install({ me: () => json({ token: makeToken(3600) }), session: () => json({ ok: true }) })
    await runCycle({ reason: 'manual', forcePush: false })

    const second = install({
      me: () => json({ token: makeToken(3600) }),
      session: () => json({ ok: true }),
    })
    await runCycle({ reason: 'manual', forcePush: true })
    expect(pushes(second)).toHaveLength(1)
  })

  it('never pushes a signed-out session, even on "Push now"', async () => {
    const recorded = install({ me: () => json({ token: '' }), session: () => json({ ok: true }) })
    const { state } = await runCycle({ reason: 'manual', forcePush: true })
    expect(state.status.push.state).toBe('no-session')
    expect(pushes(recorded)).toHaveLength(0)
  })

  it('never contacts the server before its origin permission is granted', async () => {
    setup({ grantedOrigins: [OMNI_ORIGIN_PATTERN], storage: { settings: PUSH_SETTINGS } })
    const recorded = install({
      me: () => json({ token: makeToken(3600) }),
      session: () => json({ ok: true }),
    })
    const { state } = await runCycle({ reason: 'manual', forcePush: true })

    expect(state.status.push.state).toBe('no-permission')
    expect(state.serverOriginGranted).toBe(false)
    expect(state.serverOriginPattern).toBe(SERVER_ORIGIN_PATTERN)
    expect(recorded.some((r) => r.url.includes('bot.example.com'))).toBe(false)
  })

  it('reports a missing token as unconfigured without any server call', async () => {
    setup({
      grantedOrigins: [OMNI_ORIGIN_PATTERN, SERVER_ORIGIN_PATTERN],
      storage: { settings: { ...PUSH_SETTINGS, serverToken: '' } },
    })
    const recorded = install({ me: () => json({ token: makeToken(3600) }) })
    const { state } = await runCycle({ reason: 'manual', forcePush: true })

    expect(state.status.push.state).toBe('unconfigured')
    expect(pushes(recorded)).toHaveLength(0)
  })

  it('surfaces a refused token and does not record the session as delivered', async () => {
    install({ me: () => json({ token: makeToken(3600) }), session: () => json({}, 401) })
    const { state } = await runCycle({ reason: 'manual', forcePush: false })

    expect(state.status.push.state).toBe('unauthorized')
    expect(state.status.push.fingerprint).toBeNull()
    expect(state.status.pendingPush).toBe(true)
    expect(fake.badge.text).toBe('×')
  })

  it('forgets what was delivered once push is turned off', async () => {
    install({ me: () => json({ token: makeToken(3600) }), session: () => json({ ok: true }) })
    await runCycle({ reason: 'manual', forcePush: false })

    fake.config.storage['settings'] = { ...PUSH_SETTINGS, pushEnabled: false }
    install({ me: () => json({ token: makeToken(3600) }) })
    const { state } = await runCycle({ reason: 'settings-change', forcePush: false })

    expect(state.status.push).toMatchObject({ state: 'off', fingerprint: null })
    expect(state.serverOriginPattern).toBeNull()
  })
})
