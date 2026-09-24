import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ApiError,
  AuthError,
  DryRunViolation,
  RateLimitError,
  SchemaDriftError,
  TransportError,
} from '../src/errors.js'
import { BROWSER_USER_AGENT, CookieJar, OmniHttp } from '../src/http.js'
import { RateLimiter } from '../src/rate-limit.js'
import { at, FakeClock, FakeFetch, fixture, headerOf, recordingLogger } from './helpers.js'

const okSchema = z.looseObject({ rfq_id: z.string() })

function make(options: { fetch: FakeFetch; dryRun?: boolean; dryRunMode?: 'synthetic' | 'throw' }) {
  const clock = new FakeClock()
  const http = new OmniHttp({
    baseUrl: 'https://omni.variational.io/api',
    rateLimiter: new RateLimiter({}, { now: clock.now, sleep: clock.sleep }),
    fetchImpl: options.fetch.fetch,
    dryRun: options.dryRun ?? false,
    dryRunMode: options.dryRunMode ?? 'synthetic',
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    connectedAddress: () => '0xabc',
  })
  return { http, clock }
}

describe('request building', () => {
  it('sends JSON, the connected-address header and the cookie jar', async () => {
    const fetch = new FakeFetch().push({ body: { rfq_id: 'r1' } })
    const { http } = make({ fetch })
    http.cookies.importHeader('session=abc; other=def')

    await http.request({
      method: 'POST',
      path: '/orders/cancel',
      body: { rfq_id: 'r1' },
      schema: okSchema,
      rateClass: 'order',
    })

    const call = fetch.last()
    expect(call?.url).toBe('https://omni.variational.io/api/orders/cancel')
    expect(headerOf(call, 'content-type')).toBe('application/json')
    expect(headerOf(call, 'vr-connected-address')).toBe('0xabc')
    expect(headerOf(call, 'cookie')).toBe('session=abc; other=def')
    expect(call?.body).toEqual({ rfq_id: 'r1' })
    // There is NO auth request header. The session rides as a cookie.
    expect(Object.keys(call?.headers ?? {})).not.toContain('x-omni-auth')
    expect(Object.keys(call?.headers ?? {})).not.toContain('authorization')
  })

  it('always sends a browser User-Agent, because Cloudflare 403s requests without one', async () => {
    const fetch = new FakeFetch().push({ body: { rfq_id: 'r1' } })
    const { http } = make({ fetch })

    await http.request({
      method: 'GET',
      path: '/metadata/config',
      schema: okSchema,
      rateClass: 'read',
    })

    // Verified live 2026-08-13: bare curl -> 403 "Just a moment...",
    // curl -A '<Chrome UA>' -> 200 on this exact path.
    expect(headerOf(fetch.last(), 'user-agent')).toBe(BROWSER_USER_AGENT)
    expect(BROWSER_USER_AGENT).toContain('Chrome/')
  })

  it('lets defaultHeaders override the User-Agent for a stronger impersonation shim', async () => {
    const fetch = new FakeFetch().push({ body: { rfq_id: 'r1' } })
    const clock = new FakeClock()
    const http = new OmniHttp({
      baseUrl: 'https://omni.variational.io/api',
      rateLimiter: new RateLimiter({}, { now: clock.now, sleep: clock.sleep }),
      fetchImpl: fetch.fetch,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      connectedAddress: () => undefined,
      defaultHeaders: { 'user-agent': 'custom-shim/1.0' },
    })

    await http.request({
      method: 'GET',
      path: '/metadata/config',
      schema: okSchema,
      rateClass: 'read',
    })

    expect(headerOf(fetch.last(), 'user-agent')).toBe('custom-shim/1.0')
  })

  it('serialises the query string and drops undefined params', async () => {
    const fetch = new FakeFetch().push({ body: { rfq_id: 'x' } })
    const { http } = make({ fetch })
    await http.request({
      method: 'GET',
      path: '/orders/v2',
      query: { status: 'pending', instrument: 'P-BTC-USDC-3600', limit: undefined },
      schema: okSchema,
      rateClass: 'read',
    })
    expect(fetch.last()?.url).toBe(
      'https://omni.variational.io/api/orders/v2?status=pending&instrument=P-BTC-USDC-3600',
    )
  })

  it('absorbs Set-Cookie into the jar', async () => {
    const fetch = new FakeFetch().push({
      body: { rfq_id: 'x' },
      headers: { 'set-cookie': 'sid=zzz; Path=/; HttpOnly' },
    })
    const { http } = make({ fetch })
    await http.request({ method: 'GET', path: '/me', schema: okSchema, rateClass: 'auth' })
    expect(http.cookies.get('sid')).toBe('zzz')
  })
})

describe('error classification', () => {
  it('raises AuthError on 401 and records the x-omni-auth stamp', async () => {
    const fetch = new FakeFetch().push({
      status: 401,
      body: { message: 'No token' },
      headers: { 'x-omni-auth': 'r' },
    })
    const { http } = make({ fetch })
    const err = await http
      .request({ method: 'GET', path: '/positions', schema: okSchema, rateClass: 'read' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).sessionStamped).toBe(true)
    expect((err as AuthError).message).toBe('No token')
  })

  it('raises RateLimitError on 429 and suspends the class for wait_until_seconds', async () => {
    const fetch = new FakeFetch().push({ status: 429, body: { wait_until_seconds: 12 } })
    const { http } = make({ fetch })
    const err = await http
      .request({ method: 'POST', path: '/orders/new/limit', schema: okSchema, rateClass: 'order' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).waitSeconds).toBe(12)
    expect((err as RateLimitError).banned).toBe(false)
    expect(http.rateLimiter.snapshot().order.suspendedForMs).toBeGreaterThan(11_000)
  })

  it('flags HTTP 418 as a ban', async () => {
    const fetch = new FakeFetch().push({ status: 418, body: { wait_until_seconds: 60 } })
    const { http } = make({ fetch })
    const err = await http
      .request({ method: 'POST', path: '/orders/new/market', schema: okSchema, rateClass: 'order' })
      .catch((e: unknown) => e)
    expect((err as RateLimitError).banned).toBe(true)
  })

  it('carries error_code and strips the "Validation error:" prefix on a 422', async () => {
    const fetch = new FakeFetch().push({ status: 422, body: fixture('risk-check-422.json') })
    const { http } = make({ fetch })
    const err = await http
      .request({ method: 'POST', path: '/orders/new/limit', schema: okSchema, rateClass: 'order' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
    expect((err as ApiError).errorCode).toBe('user_gross_notional_limit_risk_check')
    expect((err as ApiError).message).toBe('gross notional limit exceeded')
  })

  it('wraps a network failure as TransportError', async () => {
    const fetch = new FakeFetch().always({
      throws: Object.assign(new Error('boom'), { name: 'TypeError' }),
    })
    const { http } = make({ fetch })
    const err = await http
      .request({ method: 'GET', path: '/positions', schema: okSchema, rateClass: 'read' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).timeout).toBe(false)
  })

  it('marks an abort as a timeout', async () => {
    const fetch = new FakeFetch().always({
      throws: Object.assign(new Error('t'), { name: 'TimeoutError' }),
    })
    const { http } = make({ fetch })
    const err = await http
      .request({ method: 'GET', path: '/positions', schema: okSchema, rateClass: 'read' })
      .catch((e: unknown) => e)
    expect((err as TransportError).timeout).toBe(true)
  })
})

describe('schema drift', () => {
  it('throws SchemaDriftError carrying endpoint, issues and raw body', async () => {
    const fetch = new FakeFetch().push({ body: { rfq: 'wrong-field' } })
    const { http } = make({ fetch })
    const err = await http
      .request({ method: 'POST', path: '/orders/new/limit', schema: okSchema, rateClass: 'order' })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SchemaDriftError)
    const drift = err as SchemaDriftError
    expect(drift.endpoint).toBe('/orders/new/limit')
    expect(drift.issues.length).toBeGreaterThan(0)
    expect(drift.issues[0]?.path).toEqual(['rfq_id'])
    expect(drift.raw).toBe('{"rfq":"wrong-field"}')
    expect(drift.message).toContain('schema drift')
  })

  it('treats a JSON content-type with a non-JSON body as drift, not as text', async () => {
    const fetch = new FakeFetch().push({
      text: '<html>Just a moment...</html>',
      headers: { 'content-type': 'application/json' },
    })
    const { http } = make({ fetch })
    await expect(
      http.request({ method: 'GET', path: '/positions', schema: okSchema, rateClass: 'read' }),
    ).rejects.toBeInstanceOf(SchemaDriftError)
  })

  it('truncates a huge raw body but records that it did', async () => {
    const fetch = new FakeFetch().push({ body: { junk: 'x'.repeat(20_000) } })
    const { http } = make({ fetch })
    const err = (await http
      .request({ method: 'GET', path: '/positions', schema: okSchema, rateClass: 'read' })
      .catch((e: unknown) => e)) as SchemaDriftError
    expect(err.rawTruncated).toBe(true)
    expect(err.raw.length).toBe(16 * 1024)
  })
})

describe('retry policy', () => {
  it('retries an idempotent read on 5xx with exponential backoff', async () => {
    const fetch = new FakeFetch().push(
      { status: 503, body: { message: 'nope' } },
      { status: 503, body: { message: 'nope' } },
      { body: { rfq_id: 'ok' } },
    )
    const { http, clock } = make({ fetch })
    const before = clock.now()
    const result = await http.request({
      method: 'GET',
      path: '/positions',
      schema: okSchema,
      rateClass: 'read',
      retryable: true,
    })
    expect(result.rfq_id).toBe('ok')
    expect(fetch.count).toBe(3)
    // 300 * 0.75 + 600 * 0.75 with the injected random of 0.5.
    expect(clock.now() - before).toBe(675)
  })

  it('NEVER retries a mutating order request', async () => {
    const fetch = new FakeFetch().push(
      { status: 503, body: { message: 'nope' } },
      { body: { rfq_id: 'ok' } },
    )
    const { http } = make({ fetch })
    await expect(
      http.request({
        method: 'POST',
        path: '/orders/new/limit',
        schema: okSchema,
        rateClass: 'order',
        mutating: true,
      }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(fetch.count).toBe(1)
  })

  it('does not retry a 4xx that is not a rate limit', async () => {
    const fetch = new FakeFetch().push(
      { status: 422, body: { message: 'bad' } },
      { body: { rfq_id: 'ok' } },
    )
    const { http } = make({ fetch })
    await expect(
      http.request({
        method: 'GET',
        path: '/positions',
        schema: okSchema,
        rateClass: 'read',
        retryable: true,
      }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(fetch.count).toBe(1)
  })

  it('waits out wait_until_seconds when retrying a rate-limited read', async () => {
    const fetch = new FakeFetch().push(
      { status: 429, body: { wait_until_seconds: 3 } },
      { body: { rfq_id: 'ok' } },
    )
    const { http, clock } = make({ fetch })
    const before = clock.now()
    await http.request({
      method: 'GET',
      path: '/positions',
      schema: okSchema,
      rateClass: 'read',
      retryable: true,
    })
    expect(clock.now() - before).toBeGreaterThanOrEqual(3_250)
  })

  it('gives up after maxAttempts', async () => {
    const fetch = new FakeFetch().always({ status: 500, body: { message: 'down' } })
    const { http } = make({ fetch })
    await expect(
      http.request({
        method: 'GET',
        path: '/positions',
        schema: okSchema,
        rateClass: 'read',
        retryable: true,
      }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(fetch.count).toBe(3)
  })
})

describe('DRY_RUN gate', () => {
  it('sends zero network requests for a mutating call and returns a synthetic ack', async () => {
    const fetch = new FakeFetch()
    const { http } = make({ fetch, dryRun: true })
    const ack = await http.request({
      method: 'POST',
      path: '/orders/new/limit',
      body: { order_type: 'stop_loss' },
      schema: okSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ rfq_id: 'dry-run-1' }),
    })
    expect(ack.rfq_id).toBe('dry-run-1')
    expect(fetch.count).toBe(0)
  })

  it('logs the exact payload it suppressed', async () => {
    const fetch = new FakeFetch()
    const { logger, entries } = recordingLogger()
    const clock = new FakeClock()
    const http = new OmniHttp({
      baseUrl: 'https://omni.variational.io/api',
      rateLimiter: new RateLimiter({}, { now: clock.now, sleep: clock.sleep }),
      fetchImpl: fetch.fetch,
      dryRun: true,
      logger,
      now: clock.now,
      sleep: clock.sleep,
    })
    await http.request({
      method: 'POST',
      path: '/orders/new/limit',
      body: { order_type: 'stop_loss', trigger_price: '61234.5' },
      schema: okSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ rfq_id: 'dry' }),
    })
    const entry = entries.find((e) => e.message === 'omni.dryRun.suppressed')
    expect(at(entry?.meta, 'dryRun')).toBe(true)
    expect(at(entry?.meta, 'body')).toEqual({ order_type: 'stop_loss', trigger_price: '61234.5' })
  })

  it('still performs reads and quote mints while dry-run is on', async () => {
    const fetch = new FakeFetch().push({ body: { rfq_id: 'read-through' } })
    const { http } = make({ fetch, dryRun: true })
    const res = await http.request({
      method: 'GET',
      path: '/positions',
      schema: okSchema,
      rateClass: 'read',
    })
    expect(res.rfq_id).toBe('read-through')
    expect(fetch.count).toBe(1)
  })

  it('throws DryRunViolation in throwing mode', async () => {
    const fetch = new FakeFetch()
    const { http } = make({ fetch, dryRun: true, dryRunMode: 'throw' })
    await expect(
      http.request({
        method: 'POST',
        path: '/quotes/accept',
        schema: okSchema,
        rateClass: 'order',
        mutating: true,
      }),
    ).rejects.toBeInstanceOf(DryRunViolation)
    expect(fetch.count).toBe(0)
  })
})

describe('CookieJar', () => {
  it('parses, merges and renders a cookie header', () => {
    const jar = CookieJar.parse('a=1; b=2')
    jar.absorb(['c=3; Path=/; HttpOnly', 'a=9; Secure'])
    expect(jar.header()).toBe('a=9; b=2; c=3')
    expect(jar.size).toBe(3)
  })

  it('honours deletion via Max-Age=0', () => {
    const jar = CookieJar.parse('a=1')
    jar.absorb(['a=; Max-Age=0'])
    expect(jar.get('a')).toBeUndefined()
    expect(jar.header()).toBeUndefined()
  })
})

describe('rate-limit backpressure', () => {
  /*
   * The token wait must count against the request's own timeout. It used to sit
   * outside it -- acquire() blocked forever and only the fetch that followed was
   * given AbortSignal.timeout -- so a drained bucket produced a request that never
   * returned at all rather than one that failed.
   */
  it('fails fast instead of hanging when a token cannot arrive in time', async () => {
    const clock = new FakeClock()
    const rateLimiter = new RateLimiter(
      { meta: { tokens: 6, windowMs: 60_000 } },
      { now: clock.now, sleep: clock.sleep },
    )
    const fetch = new FakeFetch().push({ body: { rfq_id: 'r1' } })
    const http = new OmniHttp({
      baseUrl: 'https://omni.variational.io/api',
      rateLimiter,
      fetchImpl: fetch.fetch,
      dryRun: false,
      dryRunMode: 'synthetic',
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      connectedAddress: () => '0xabc',
    })

    for (let i = 0; i < 6; i++) rateLimiter.tryAcquire('meta')

    await expect(
      http.request({
        method: 'GET',
        path: '/metadata/risk_limits',
        rateClass: 'meta',
        schema: okSchema,
        timeoutMs: 8_000,
      }),
    ).rejects.toThrow(/rate limit/i)

    // And it never reached the wire -- the point is to shed load, not to queue it.
    expect(fetch.calls.length).toBe(0)
  })
})
