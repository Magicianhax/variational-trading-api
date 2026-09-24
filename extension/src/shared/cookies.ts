/**
 * Cookie selection.
 *
 * The venue session *is* a set of server-set HttpOnly cookies (the `vr-*` ones) —
 * page scripts cannot read them, which is why this is an extension and not a
 * bookmarklet. What must NOT be exported are the analytics/marketing cookies
 * that share the origin (user-tracking data nobody needs) and the Cloudflare
 * cookies, which are bound to the browser that earned them: replayed from another
 * client they turn clean answers into challenges.
 *
 * Why a denylist rather than a `vr-*` allowlist: see `src/cookie-policy.ts`.
 */

/*
 * The denylist itself lives in the client (`src/cookie-policy.ts`) so the extension's
 * export and the client's `cleanCookieHeader` can never drift apart. esbuild bundles it.
 */
import { isExcludedCookie } from '../../../src/cookie-policy.js'

/** The subset of `chrome.cookies.Cookie` the extension reads. */
export interface RawCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly hostOnly: boolean
  readonly session: boolean
  readonly sameSite: string
  readonly expirationDate?: number | undefined
}

export {
  ANALYTICS_COOKIE_NAMES,
  ANALYTICS_COOKIE_PREFIXES,
  CLOUDFLARE_COOKIE_PREFIXES,
  isAnalyticsCookie,
  isCloudflareCookie,
  isExcludedCookie,
} from '../../../src/cookie-policy.js'

/**
 * Filter a raw cookie jar down to the session-bearing set, in a deterministic
 * order so that the fingerprint of an unchanged jar is stable.
 *
 * Same-name cookies are ordered longest path first, which is the order a browser
 * sends them in (RFC 6265 §5.4) — a server that reads the first match then sees
 * the same value it would from the web app.
 *
 * Cookies with an empty value are dropped: a cleared cookie carries no session.
 */
export function selectSessionCookies(cookies: readonly RawCookie[]): RawCookie[] {
  return cookies
    .filter((c) => c.value !== '' && !isExcludedCookie(c.name))
    .sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1
      if (a.path.length !== b.path.length) return b.path.length - a.path.length
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })
}

/** Names dropped by {@link selectSessionCookies}, for the "what we skipped" UI. */
export function droppedCookieNames(cookies: readonly RawCookie[]): string[] {
  return Array.from(
    new Set(cookies.filter((c) => isExcludedCookie(c.name)).map((c) => c.name)),
  ).sort()
}

/** Serialise cookies the way a `Cookie:` request header carries them. */
export function toCookieHeader(cookies: readonly RawCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}
