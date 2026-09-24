/**
 * Typed error hierarchy.
 *
 * Every failure mode a caller has to branch on is a distinct class:
 *
 *  - {@link AuthError}        -> the session is gone: stop sending orders, get a new one
 *  - {@link SchemaDriftError} -> the venue changed a shape: stop, never guess
 *  - {@link RateLimitError}   -> back off the offending endpoint class
 *  - {@link DryRunViolation}  -> a mutating call was attempted in dry-run mode
 *
 * Nothing here reaches for the network or the clock.
 */

import type { $ZodIssue } from 'zod/v4/core'
import { redactText, redactValue } from './redact.js'

/** Root of the hierarchy. Every error this package throws is an `OmniError`. */
export class OmniError extends Error {
  /** API path the failure is attributed to, e.g. `/orders/new/limit`. */
  readonly endpoint: string | undefined

  constructor(message: string, endpoint?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.endpoint = endpoint
    // Restore the prototype chain across the ES5 `extends Error` downlevel gap.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * The venue answered with a non-2xx status and a body we could read.
 *
 * `errorCode` is Omni's `error_code` discriminator (e.g. `skewLimitExceeded`; see
 * docs/API.md); `body` is the parsed JSON (or raw text) as received, with credential
 * values (tokens, JWTs, session cookies) masked so printing the error cannot leak them.
 */
export class ApiError extends OmniError {
  readonly status: number
  readonly errorCode: string | undefined
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>

  constructor(args: {
    message: string
    status: number
    endpoint: string
    body?: unknown
    errorCode?: string | undefined
    headers?: Readonly<Record<string, string>>
    cause?: unknown
  }) {
    super(args.message, args.endpoint, args.cause === undefined ? undefined : { cause: args.cause })
    this.status = args.status
    this.errorCode = args.errorCode
    this.body = redactValue(args.body)
    this.headers = args.headers ?? {}
  }
}

/**
 * HTTP 429 (too many requests) or HTTP 418 (temporary order ban).
 *
 * Both carry `{ wait_until_seconds: N }` in the body; `waitSeconds`
 * is that value when present, otherwise a conservative default supplied by the
 * transport.
 */
export class RateLimitError extends ApiError {
  readonly waitSeconds: number
  /** True for HTTP 418 — the venue's "temporarily banned from orders" signal. */
  readonly banned: boolean

  constructor(args: {
    message: string
    status: number
    endpoint: string
    waitSeconds: number
    body?: unknown
    headers?: Readonly<Record<string, string>>
  }) {
    super({
      message: args.message,
      status: args.status,
      endpoint: args.endpoint,
      body: args.body,
      ...(args.headers === undefined ? {} : { headers: args.headers }),
    })
    this.waitSeconds = args.waitSeconds
    this.banned = args.status === 418
  }
}

/**
 * HTTP 401. The venue stamps `x-omni-auth: r` on responses that came
 * out of the authenticated-session middleware; `sessionStamped` reflects that,
 * because a 401 *with* the stamp is the one that means "your session is dead"
 * rather than "this endpoint wants something else".
 */
export class AuthError extends ApiError {
  readonly sessionStamped: boolean

  constructor(args: {
    message: string
    endpoint: string
    body?: unknown
    headers?: Readonly<Record<string, string>>
    sessionStamped?: boolean
  }) {
    super({
      message: args.message,
      status: 401,
      endpoint: args.endpoint,
      body: args.body,
      ...(args.headers === undefined ? {} : { headers: args.headers }),
    })
    this.sessionStamped = args.sessionStamped ?? false
  }
}

/** Truncation bound for the raw body we keep on a drift error (16 KB). */
export const RAW_BODY_LIMIT = 16 * 1024

/**
 * A response did not match its zod schema. Stop rather than proceed on a guessed
 * shape — a misread order or position is worse than no answer.
 *
 * Carries the endpoint, the zod issues, and the raw body (truncated) so the
 * drift can be diagnosed offline without a live reproduction. Credential values in
 * the body are masked first: a drift on `/me` would otherwise carry the live JWT
 * into every terminal and bug report that prints the error.
 */
export class SchemaDriftError extends OmniError {
  readonly issues: readonly $ZodIssue[]
  readonly raw: string
  readonly rawTruncated: boolean

  constructor(args: { endpoint: string; issues: readonly $ZodIssue[]; raw: unknown }) {
    const issues = args.issues
    const summary = issues
      .slice(0, 4)
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('; ')
    super(
      `schema drift: ${args.endpoint} — ${summary}${issues.length > 4 ? ` (+${issues.length - 4} more)` : ''}`,
      args.endpoint,
    )
    this.issues = issues
    const raw = redactText(typeof args.raw === 'string' ? args.raw : safeStringify(args.raw))
    this.rawTruncated = raw.length > RAW_BODY_LIMIT
    this.raw = this.rawTruncated ? raw.slice(0, RAW_BODY_LIMIT) : raw
  }
}

/** A mutating call was attempted while the client is in throwing dry-run mode. */
export class DryRunViolation extends OmniError {
  readonly method: string
  readonly payload: unknown

  constructor(args: { endpoint: string; method: string; payload?: unknown }) {
    super(`DRY_RUN: refused ${args.method} ${args.endpoint}`, args.endpoint)
    this.method = args.method
    this.payload = args.payload
  }
}

/** The request exceeded the client timeout or the socket died mid-flight. */
export class TransportError extends OmniError {
  /** True when the failure was specifically a timeout rather than a socket error. */
  readonly timeout: boolean

  constructor(message: string, endpoint: string, opts?: { timeout?: boolean; cause?: unknown }) {
    super(message, endpoint, opts?.cause === undefined ? undefined : { cause: opts.cause })
    this.timeout = opts?.timeout ?? false
  }
}

/** A caller passed something the wire format cannot represent. */
export class InvalidRequestError extends OmniError {}

/** JSON.stringify that never throws (cycles, BigInt, ...). */
function safeStringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ??
      String(value)
    )
  } catch {
    return String(value)
  }
}

/** Type guard bundle — cheaper and safer than `instanceof` across bundler realms. */
export const isOmniError = (e: unknown): e is OmniError => e instanceof OmniError
export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError
export const isAuthError = (e: unknown): e is AuthError => e instanceof AuthError
export const isRateLimitError = (e: unknown): e is RateLimitError => e instanceof RateLimitError
export const isSchemaDriftError = (e: unknown): e is SchemaDriftError =>
  e instanceof SchemaDriftError
