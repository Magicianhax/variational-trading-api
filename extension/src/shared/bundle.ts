/**
 * The session bundle: the one payload this extension ever hands out, whether it
 * is copied, downloaded as `session.json`, or pushed to a server.
 *
 * The shape is the client library's `SessionBundle` (`src/session-bundle.ts` at
 * the repo root), so `OmniClient.fromSession('session.json')` reads the file as
 * is. A compile-time test in `bundle.test.ts` fails if the two drift apart.
 *
 * Everything in it is either the credential (the cookie string, the `/me` JWT)
 * or read off that credential (address, expiry). No page content, no browsing
 * history, no positions, no balances.
 */

import type { RawCookie } from './cookies.js'
import { toCookieHeader } from './cookies.js'
import { decodeJwtClaims } from './jwt.js'

export interface SessionBundle {
  /** The JWT from `GET /api/me`. Optional for the client, which re-derives it from the cookies. */
  token: string
  /** `name=value; name=value` — the venue cookies. This is the actual credential. */
  cookies: string
  /** `address` claim off the JWT, exactly as the venue wrote it. */
  address?: string
  /**
   * Part of the client's format but never filled in here: the client deliberately
   * does not replay it, and a browser's user agent is fingerprinting data that
   * nobody downstream needs.
   */
  userAgent?: string
  /** JWT `exp`, epoch milliseconds. */
  expiresAt?: number
}

/** Build a bundle from a `/me` token and an already-filtered cookie jar. */
export function buildSessionBundle(token: string, cookies: readonly RawCookie[]): SessionBundle {
  const claims = decodeJwtClaims(token)
  const bundle: SessionBundle = { token, cookies: toCookieHeader(cookies) }
  // Keys are added only when known: under the client's strict optional types an
  // explicit `undefined` is not the same as an absent field.
  if (claims.address !== null) bundle.address = claims.address
  if (claims.exp !== null) bundle.expiresAt = Math.round(claims.exp * 1000)
  return bundle
}

/** The exact text of `session.json`: pretty-printed so a human can inspect it before use. */
export function serializeBundle(bundle: SessionBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

/**
 * Canonical string used for change detection. Includes only the credential —
 * the derived claims follow from the token, so they add nothing.
 */
export function fingerprintInput(bundle: SessionBundle): string {
  return `${bundle.token}\n${bundle.cookies}`
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * SHA-256 of {@link fingerprintInput}. Stored (never the raw material) so the
 * extension can tell "the session changed" from "nothing happened" without
 * keeping a copy of the credential in storage.
 */
export async function fingerprintBundle(bundle: SessionBundle): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprintInput(bundle))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(digest)
}
