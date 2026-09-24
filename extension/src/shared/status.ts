/**
 * Status model + the pure functions that derive it.
 *
 * Every function here is a total function of its inputs: no clock reads, no
 * chrome APIs, no io. `nowMs` is always passed in, which makes the whole status
 * surface directly unit-testable.
 *
 * The status object is persisted in `chrome.storage.local` so the popup can
 * paint instantly on open, which makes storage an external boundary — hence the
 * zod schemas rather than bare interfaces. It never holds the credential itself,
 * only a digest of it.
 */

import * as z from 'zod/mini'
import { EXPIRY_WARN_MS } from './constants.js'
import type { OmniJwtClaims } from './jwt.js'

/** How the browser-side venue session looks right now. */
export const SessionStateSchema = z.enum([
  /** Not checked yet. */
  'unknown',
  /** Token present, expiry (if any) comfortably in the future. */
  'ok',
  /** Token present but `exp` is within the warning window. */
  'expiring',
  /** Token present and `exp` has passed. */
  'expired',
  /** `GET /api/me` returned `{ token: "" }` — signed out. */
  'absent',
  /** Cloudflare challenged the check; we cannot tell. */
  'blocked',
  /** Network or parse failure. */
  'error',
])
export type SessionState = z.infer<typeof SessionStateSchema>

/** Outcome of the optional push to the user's own server. */
export const PushStateSchema = z.enum([
  /** Push is turned off in settings (the default). */
  'off',
  'never',
  'ok',
  'error',
  /** The server rejected the bearer token (401/403). */
  'unauthorized',
  /** Server URL or token not configured. */
  'unconfigured',
  /** Host permission for the server origin has not been granted. */
  'no-permission',
  /** Nothing to push — no usable session in the browser. */
  'no-session',
])
export type PushState = z.infer<typeof PushStateSchema>

export const SessionStatusSchema = z.object({
  state: SessionStateSchema,
  address: z.nullable(z.string()),
  /** Unix ms, or null. */
  expiresAt: z.nullable(z.number()),
  scope: z.nullable(z.string()),
  cookieCount: z.int().check(z.gte(0)),
  /** Names of analytics / Cloudflare cookies deliberately left out of the bundle. */
  droppedCookies: z.array(z.string()),
  /** Digest of the bundle currently in the browser — never the bundle itself. */
  fingerprint: z.nullable(z.string()),
  detail: z.string(),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const PushStatusSchema = z.object({
  state: PushStateSchema,
  /** Unix ms of the last push attempt, or null. */
  at: z.nullable(z.number()),
  /** Digest of the bundle the server last accepted, or null. */
  fingerprint: z.nullable(z.string()),
  /**
   * Base URL that accepted {@link fingerprint}. Pointing the extension at a
   * different server must re-push, even though the session itself is unchanged.
   */
  server: z.nullable(z.string()),
  detail: z.string(),
})
export type PushStatus = z.infer<typeof PushStatusSchema>

export const ExporterStatusSchema = z.object({
  updatedAt: z.number(),
  session: SessionStatusSchema,
  push: PushStatusSchema,
  /** True when push is on and the browser holds a session the server has not accepted. */
  pendingPush: z.boolean(),
})
export type ExporterStatus = z.infer<typeof ExporterStatusSchema>

export const INITIAL_STATUS: ExporterStatus = {
  updatedAt: 0,
  session: {
    state: 'unknown',
    address: null,
    expiresAt: null,
    scope: null,
    cookieCount: 0,
    droppedCookies: [],
    fingerprint: null,
    detail: 'Not checked yet.',
  },
  push: { state: 'off', at: null, fingerprint: null, server: null, detail: 'Push is off.' },
  pendingPush: false,
}

export interface TokenClassification {
  readonly state: SessionState
  readonly expiresAt: number | null
  readonly detail: string
}

/** Classify a `/me` token plus its claims into a {@link SessionState}. */
export function classifyToken(
  token: string,
  claims: OmniJwtClaims,
  nowMs: number,
  warnMs: number = EXPIRY_WARN_MS,
): TokenClassification {
  if (token === '') {
    return {
      state: 'absent',
      expiresAt: null,
      detail: 'Signed out. Sign in at omni.variational.io, then re-check.',
    }
  }
  if (claims.exp === null) {
    return { state: 'ok', expiresAt: null, detail: 'Signed in (the token has no expiry claim).' }
  }
  const expiresAt = claims.exp * 1000
  const remaining = expiresAt - nowMs
  if (remaining <= 0) {
    return {
      state: 'expired',
      expiresAt,
      detail: 'Session has expired. Sign in again at omni.variational.io.',
    }
  }
  if (remaining <= warnMs) {
    return {
      state: 'expiring',
      expiresAt,
      detail: `Session expires in ${formatDuration(remaining)}. Sign in again soon.`,
    }
  }
  return {
    state: 'ok',
    expiresAt,
    detail: `Signed in. Session valid for ${formatDuration(remaining)}.`,
  }
}

/**
 * True when a session in this state is worth handing out. An expiring session
 * still works until `exp`; an expired one would only produce a confusing 401
 * wherever it lands.
 */
export function isExportable(state: SessionState): boolean {
  return state === 'ok' || state === 'expiring'
}

/**
 * Should the extension push right now?
 *
 * Push when the credential has changed since the server last accepted one — but
 * never when push is off or the browser has nothing worth sending.
 */
export function shouldPush(args: {
  readonly pushEnabled: boolean
  readonly sessionState: SessionState
  readonly bundleFingerprint: string | null
  readonly lastAcceptedFingerprint: string | null
  readonly autoPush: boolean
  readonly forced: boolean
}): boolean {
  if (!args.pushEnabled) return false
  if (args.bundleFingerprint === null) return false
  if (!isExportable(args.sessionState)) return false
  if (args.forced) return true
  if (!args.autoPush) return false
  return args.bundleFingerprint !== args.lastAcceptedFingerprint
}

/** Overall level for the toolbar badge and the popup header. */
export function warningLevel(status: ExporterStatus): 'ok' | 'warn' | 'error' {
  const s = status.session.state
  if (s === 'absent' || s === 'expired' || s === 'error') return 'error'
  const p = status.push.state
  if (p === 'error' || p === 'unauthorized' || p === 'no-permission') return 'error'
  if (s === 'unknown' || s === 'expiring' || s === 'blocked') return 'warn'
  if (p === 'unconfigured' || status.pendingPush) return 'warn'
  return 'ok'
}

/** Compact human duration: `4d 2h`, `2h 13m`, `47s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
