/**
 * HTTP transport for the Omni private API.
 *
 * Responsibilities, in the order they run:
 *
 *   dry-run gate -> rate limiter -> fetch -> status classification ->
 *   zod parse -> typed result
 *
 * Deliberate design points:
 *
 *  - **Nothing is auto-retried unless it is explicitly marked retryable**, and
 *    the only calls marked retryable are idempotent reads. An order POST that
 *    times out may well have executed; retrying it could double a position.
 *    Resolve those against `/orders/v2` instead.
 *  - **Every response goes through a zod schema.** A parse failure throws
 *    `SchemaDriftError` carrying endpoint + issues + raw body.
 *  - **The session is a cookie**, not a header. `x-omni-auth: r` is a RESPONSE
 *    stamp the venue puts on answers from its authenticated middleware; we read
 *    it to tell a "your session is dead" 401 from an endpoint-specific one.
 *  - Clock, sleep, randomness and `fetch` are all injectable, so the whole
 *    transport is testable with zero timers and zero network.
 */

import { z } from 'zod'
import {
  ApiError,
  AuthError,
  DryRunViolation,
  RateLimitError,
  SchemaDriftError,
  TransportError,
} from './errors.js'
import type { RateClass, RateLimiter } from './rate-limit.js'

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

export type LogFn = (message: string, meta?: Record<string, unknown>) => void
export type Logger = { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn }

const noop: LogFn = () => {}
export const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop }

/* -------------------------------------------------------------------------- */
/* Cookie jar                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A deliberately small cookie jar: name -> value, no domain/path/expiry logic.
 *
 * That is sufficient and correct here because every request goes to exactly one
 * origin (`omni.variational.io`). Attributes are parsed off and discarded; a
 * `Max-Age=0` / `Expires` in the past deletes the cookie.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>()

  /** Build a jar from a `document.cookie`-style string (as copied from a browser). */
  static parse(header: string): CookieJar {
    const jar = new CookieJar()
    jar.importHeader(header)
    return jar
  }

  importHeader(header: string): void {
    for (const pair of header.split(';')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name !== '') this.cookies.set(name, value)
    }
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value)
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)
  }

  delete(name: string): void {
    this.cookies.delete(name)
  }

  get size(): number {
    return this.cookies.size
  }

  /** Absorb `Set-Cookie` headers from a response. */
  absorb(setCookies: readonly string[]): void {
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';')
      if (pair === undefined) continue
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name === '') continue

      const expired = attrs.some((a) => {
        const attr = a.trim().toLowerCase()
        if (attr.startsWith('max-age=')) return Number(attr.slice('max-age='.length)) <= 0
        if (attr.startsWith('expires=')) {
          const ts = Date.parse(a.trim().slice('expires='.length))
          return !Number.isNaN(ts) && ts <= Date.now()
        }
        return false
      })

      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  /** The `Cookie` request header, or `undefined` when the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /**
   * The jar as one `Cookie:` header value, for a SessionBundle.
   *
   * `session.ts` relies on this to hand the fresh session back as a bundle.
   */
  serialize(): string {
    return this.header() ?? ''
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.cookies)
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** What to do with a mutating call while `dryRun` is on. */
export type DryRunMode = 'synthetic' | 'throw'

export type RetryPolicy = {
  /** Total attempts including the first. `1` disables retrying. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 8_000 }

/** Default request timeout — matches the reference client's `d_ = 30000`. */
export const DEFAULT_TIMEOUT_MS = 30_000

export type TransportOptions = {
  baseUrl: string
  rateLimiter: RateLimiter
  cookies?: CookieJar
  /** Sent as `vr-connected-address` when it resolves to a non-empty string. */
  connectedAddress?: () => string | undefined
  logger?: Logger
  fetchImpl?: FetchLike
  timeoutMs?: number
  retry?: Partial<RetryPolicy>
  dryRun?: boolean
  dryRunMode?: DryRunMode
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Extra headers merged into every request (e.g. a different User-Agent). */
  defaultHeaders?: Readonly<Record<string, string>>
}

export type RequestSpec<T> = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined> | undefined
  body?: unknown
  schema: z.ZodType<T>
  rateClass: RateClass
  /**
   * True when the call changes venue state. Mutating calls are gated by DRY_RUN
   * and are NEVER auto-retried.
   */
  mutating?: boolean
  /** Allow automatic retry on 429/418/5xx/network. Only ever set on idempotent reads. */
  retryable?: boolean
  /** Value returned instead of hitting the network in synthetic dry-run mode. */
  dryRunResult?: () => unknown
  timeoutMs?: number
  /** Extra headers for this call only (Turnstile tokens, etc.). */
  headers?: Record<string, string>
}

/** Bodies that carry `{ wait_until_seconds }` on 418/429. */
const waitBodySchema = z.looseObject({ wait_until_seconds: z.number() })

/** Structured error envelope: `message` / `error_message` / `error_code`. */
const errorBodySchema = z.looseObject({
  message: z.string().nullish(),
  error_message: z.string().nullish(),
  error_code: z.string().nullish(),
})

const VALIDATION_PREFIX = 'Validation error:'

/**
 * Default UA for every request. Cloudflare's challenge on `/api` keys off this header,
 * so omitting it makes every call fail with 403 before it reaches Variational at all.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

export class OmniHttp {
  readonly cookies: CookieJar
  readonly rateLimiter: RateLimiter
  private readonly baseUrl: string
  private readonly logger: Logger
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly retry: RetryPolicy
  private readonly dryRunMode: DryRunMode
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly connectedAddress: () => string | undefined
  private readonly defaultHeaders: Readonly<Record<string, string>>

  /** Mutable so a caller can flip a kill switch without rebuilding the client. */
  dryRun: boolean

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.rateLimiter = options.rateLimiter
    this.cookies = options.cookies ?? new CookieJar()
    this.logger = options.logger ?? noopLogger
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retry = { ...DEFAULT_RETRY, ...options.retry }
    this.dryRun = options.dryRun ?? true
    this.dryRunMode = options.dryRunMode ?? 'synthetic'
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
    this.random = options.random ?? Math.random
    this.connectedAddress = options.connectedAddress ?? (() => undefined)
    this.defaultHeaders = options.defaultHeaders ?? {}
  }

  private url(path: string, query?: RequestSpec<unknown>['query']): string {
    const p = path.startsWith('/') ? path : `/${path}`
    if (query === undefined) return `${this.baseUrl}${p}`
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue
      params.set(k, String(v))
    }
    const qs = params.toString()
    return qs === '' ? `${this.baseUrl}${p}` : `${this.baseUrl}${p}?${qs}`
  }

  /** Execute one request end to end. */
  async request<T>(spec: RequestSpec<T>): Promise<T> {
    if (spec.mutating === true && this.dryRun) return this.handleDryRun(spec)

    const attempts = spec.retryable === true ? Math.max(1, this.retry.maxAttempts) : 1
    let lastError: unknown

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // The wait for a token counts against the caller's timeout. Queueing past it
      // would spend the token on a caller who has already given up, starving one who
      // has not -- see RateLimiter.acquire.
      await this.rateLimiter.acquire(spec.rateClass, {
        timeoutMs: spec.timeoutMs ?? this.timeoutMs,
      })
      try {
        return await this.attempt(spec)
      } catch (err) {
        lastError = err
        if (attempt === attempts || !this.isRetryable(err)) throw err
        const delay = this.retryDelay(err, attempt)
        this.logger.warn('omni.retry', {
          endpoint: spec.path,
          attempt,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        })
        await this.sleep(delay)
      }
    }
    /* c8 ignore next -- the loop always returns or throws */
    throw lastError
  }

  private handleDryRun<T>(spec: RequestSpec<T>): T {
    const payload = { method: spec.method, path: spec.path, query: spec.query, body: spec.body }
    if (this.dryRunMode === 'throw') {
      throw new DryRunViolation({ endpoint: spec.path, method: spec.method, payload })
    }
    this.logger.warn('omni.dryRun.suppressed', { ...payload, dryRun: true })
    const synthetic = spec.dryRunResult?.() ?? { rfq_id: `dry-run-${spec.path}` }
    const parsed = spec.schema.safeParse(synthetic)
    if (!parsed.success) {
      // A synthetic response that does not satisfy its own schema is a bug in
      // this client, not schema drift at the venue — surface it loudly.
      throw new SchemaDriftError({
        endpoint: `${spec.path} (dry-run synthetic)`,
        issues: parsed.error.issues,
        raw: synthetic,
      })
    }
    return parsed.data
  }

  private async attempt<T>(spec: RequestSpec<T>): Promise<T> {
    const url = this.url(spec.path, spec.query)
    const address = this.connectedAddress()
    const cookie = this.cookies.header()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Cloudflare fronts /api and 403s ("Just a moment...") any request without a
      // browser User-Agent. Verified 2026-08-13: bare curl -> 403, curl -A <Chrome UA>
      // -> 200 on the same path. The UA alone is the discriminator today, so a plain
      // client passes. `defaultHeaders` can replace it, e.g. with your own browser's UA.
      'user-agent': BROWSER_USER_AGENT,
      ...this.defaultHeaders,
      ...spec.headers,
      // The session is a COOKIE; there is no auth request header anywhere.
      ...(address === undefined || address === '' ? {} : { 'vr-connected-address': address }),
      ...(cookie === undefined ? {} : { cookie }),
    }

    const init: RequestInit = {
      method: spec.method,
      headers,
      signal: AbortSignal.timeout(spec.timeoutMs ?? this.timeoutMs),
    }
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body)

    const started = this.now()
    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (err) {
      const timeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new TransportError(
        timeout
          ? `request timed out after ${spec.timeoutMs ?? this.timeoutMs}ms`
          : `network failure: ${String(err)}`,
        spec.path,
        { timeout, cause: err },
      )
    }

    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    if (setCookies.length > 0) this.cookies.absorb(setCookies)

    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const isJson = contentType.includes('application/json')
    let body: unknown = text
    if (isJson && text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        // A JSON content-type with a non-JSON body is drift, not a soft failure.
        throw new SchemaDriftError({
          endpoint: spec.path,
          issues: [
            {
              code: 'custom',
              message: 'response declared application/json but the body is not valid JSON',
              path: [],
              input: text,
            },
          ],
          raw: text,
        })
      }
    }

    this.logger.debug('omni.http', {
      endpoint: spec.path,
      method: spec.method,
      status: response.status,
      ms: this.now() - started,
    })

    if (!response.ok) throw this.toError(spec, response, body)

    // An empty body is legal for the endpoints whose response the reference
    // client discards; those declare `z.unknown()` and accept `""`.
    const parsed = spec.schema.safeParse(body)
    if (!parsed.success) {
      throw new SchemaDriftError({ endpoint: spec.path, issues: parsed.error.issues, raw: text })
    }
    return parsed.data
  }

  private toError(spec: RequestSpec<unknown>, response: Response, body: unknown): Error {
    const headers = headersToRecord(response.headers)
    const envelope = errorBodySchema.safeParse(body)
    const rawMessage = envelope.success
      ? (envelope.data.message ?? envelope.data.error_message ?? '')
      : ''
    const message = (rawMessage ?? '').startsWith(VALIDATION_PREFIX)
      ? (rawMessage ?? '').slice(VALIDATION_PREFIX.length).trim()
      : (rawMessage ?? '') === ''
        ? `HTTP ${response.status}`
        : (rawMessage ?? '')
    const errorCode = envelope.success ? (envelope.data.error_code ?? undefined) : undefined

    if (response.status === 401) {
      return new AuthError({
        message,
        endpoint: spec.path,
        body,
        headers,
        sessionStamped: headers['x-omni-auth'] === 'r',
      })
    }

    if (response.status === 429 || response.status === 418) {
      const wait = waitBodySchema.safeParse(body)
      const waitSeconds = wait.success ? wait.data.wait_until_seconds : 5
      this.rateLimiter.suspend(spec.rateClass, waitSeconds)
      return new RateLimitError({
        message:
          message === `HTTP ${response.status}` ? `rate limited for ${waitSeconds}s` : message,
        status: response.status,
        endpoint: spec.path,
        waitSeconds,
        body,
        headers,
      })
    }

    return new ApiError({
      message,
      status: response.status,
      endpoint: spec.path,
      body,
      errorCode,
      headers,
    })
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof RateLimitError) return true
    if (err instanceof TransportError) return true
    if (err instanceof ApiError) return err.status >= 500
    return false
  }

  private retryDelay(err: unknown, attempt: number): number {
    if (err instanceof RateLimitError) return err.waitSeconds * 1000 + 250
    const exponential = this.retry.baseDelayMs * 2 ** (attempt - 1)
    const capped = Math.min(this.retry.maxDelayMs, exponential)
    // Full jitter: spreads a thundering herd of reconnecting clients.
    return Math.round(capped * (0.5 + this.random() * 0.5))
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}
