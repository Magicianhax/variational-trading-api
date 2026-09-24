/**
 * Everything that touches `omni.variational.io`.
 *
 * Exactly two reads happen here and nowhere else in the extension:
 *
 *   1. `chrome.cookies.getAll({ url: 'https://omni.variational.io/api/' })`
 *      — the session credential itself (HttpOnly, so only an extension can read it).
 *   2. `GET https://omni.variational.io/api/me` — returns `{ token }`, the JWT
 *      that says whether the cookies are signed in, as whom, and until when.
 *
 * No other venue endpoint is ever called, no page DOM is ever read, and no other
 * origin is ever contacted from here.
 */

import * as z from 'zod/mini'
import {
  CF_MITIGATED_HEADER,
  OMNI_COOKIE_URL,
  OMNI_ME_URL,
  OMNI_TIMEOUT_MS,
} from '../shared/constants.js'
import type { RawCookie } from '../shared/cookies.js'
import { droppedCookieNames, selectSessionCookies } from '../shared/cookies.js'
import { errorMessage } from '../shared/log.js'

/**
 * `GET /api/me` -> `{ token, intercomUserJwt }`.
 *
 * Only `token` is declared, so zod's default strip behaviour drops
 * `intercomUserJwt` (a support-widget credential nobody downstream needs) before
 * it can reach the bundle.
 */
const MeResponseSchema = z.object({ token: z.nullish(z.string()) })

export type MeProbe =
  /** `token` may legitimately be `''` — that means "signed out". */
  | { readonly kind: 'ok'; readonly token: string }
  /** Cloudflare challenged us, or the body was not JSON. */
  | { readonly kind: 'blocked'; readonly detail: string }
  /** Network failure, unexpected status, or a zod parse failure. */
  | { readonly kind: 'error'; readonly detail: string }

export interface CookieHarvest {
  readonly cookies: RawCookie[]
  readonly dropped: string[]
}

/** Read and filter the venue cookie jar. */
export async function harvestCookies(): Promise<CookieHarvest> {
  const raw = await chrome.cookies.getAll({ url: OMNI_COOKIE_URL })
  const mapped: RawCookie[] = raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    hostOnly: c.hostOnly,
    session: c.session,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
  }))
  return { cookies: selectSessionCookies(mapped), dropped: droppedCookieNames(mapped) }
}

function isChallenge(status: number, cfMitigated: string | null, contentType: string): boolean {
  if (cfMitigated === 'challenge') return true
  if (status === 403 && !contentType.includes('application/json')) return true
  return false
}

/**
 * Read the current session JWT with `GET /api/me`.
 *
 * `credentials: 'include'` attaches the venue cookies because the manifest holds
 * the `https://omni.variational.io/*` host permission; the same permission
 * exempts the request from CORS. It goes out on the browser's own network stack,
 * so it carries the same TLS fingerprint and Cloudflare clearance as the open
 * site — which is why it passes where a script on a server would be challenged.
 */
export async function readSessionToken(): Promise<MeProbe> {
  let response: Response
  try {
    response = await fetch(OMNI_ME_URL, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(OMNI_TIMEOUT_MS),
    })
  } catch (error) {
    return { kind: 'error', detail: errorMessage(error) }
  }

  const contentType = response.headers.get('content-type') ?? ''
  const cfMitigated = response.headers.get(CF_MITIGATED_HEADER)
  if (isChallenge(response.status, cfMitigated, contentType)) {
    return {
      kind: 'blocked',
      detail: `Cloudflare challenged GET /api/me (HTTP ${response.status}).`,
    }
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: 'ok', token: '' }
  }
  if (!response.ok) {
    return { kind: 'error', detail: `GET /api/me returned HTTP ${response.status}.` }
  }
  if (!contentType.includes('application/json')) {
    return { kind: 'blocked', detail: `GET /api/me returned ${contentType || 'no content-type'}.` }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    return { kind: 'error', detail: `GET /api/me body was not JSON: ${errorMessage(error)}` }
  }
  const parsed = MeResponseSchema.safeParse(body)
  if (!parsed.success) {
    return { kind: 'error', detail: 'GET /api/me did not match the expected `{ token }` shape.' }
  }
  return { kind: 'ok', token: parsed.data.token ?? '' }
}
