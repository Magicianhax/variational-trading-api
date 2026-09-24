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
 * This is a *denylist*, not a `vr-*` allowlist, on purpose: if the venue adds or
 * renames a session cookie, an allowlist would silently drop the credential while
 * a denylist keeps working. The list only matches vendor cookie names that cannot
 * plausibly be a first-party session.
 */

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

/** Exact cookie names that are never part of a session. */
export const ANALYTICS_COOKIE_NAMES: ReadonlySet<string> = new Set([
  '_gid',
  '_fbp',
  '_fbc',
  '_dd_s',
  '_uetsid',
  '_uetvid',
  '_clck',
  '_clsk',
  '_rdt_uuid',
  '_ttp',
  '_tt_enable_cookie',
  '_scid',
  '_sctr',
  '_pin_unauth',
  'IDE',
  'MUID',
  'li_sugr',
  'lidc',
  'bcookie',
  'bscookie',
  'sa-user-id',
  'sa-user-id-v2',
  'sa-user-id-v3',
])

/** Cookie-name prefixes owned by analytics/marketing vendors (matched case-insensitively). */
export const ANALYTICS_COOKIE_PREFIXES: readonly string[] = [
  // `_ga`, `_ga_<id>`, `_gac_*`, `_gat`, `_gat_<id>` — every Google Analytics family.
  '_ga',
  '_gcl_',
  '_hj',
  '_pk_',
  '_vwo',
  '_uet',
  'ajs_',
  'amp_',
  'amplitude',
  'mp_',
  'ph_',
  'intercom-',
  '__hs',
  'hubspotutk',
  '__stripe',
  'optimizely',
  'datadog',
  '_dd_',
  'ko_',
  '_omappvp',
]

/** Cloudflare cookie prefixes: `__cf_bm`, `__cflb`, `_cfuvid`, `cf_clearance`, `cf_*`. */
export const CLOUDFLARE_COOKIE_PREFIXES: readonly string[] = ['__cf', '_cfuvid', 'cf_']

function hasPrefix(name: string, prefixes: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))
}

/** True when a cookie name belongs to a known analytics/marketing vendor. */
export function isAnalyticsCookie(name: string): boolean {
  return ANALYTICS_COOKIE_NAMES.has(name) || hasPrefix(name, ANALYTICS_COOKIE_PREFIXES)
}

/** True when a cookie name belongs to Cloudflare's bot-management layer. */
export function isCloudflareCookie(name: string): boolean {
  return hasPrefix(name, CLOUDFLARE_COOKIE_PREFIXES)
}

/** True when a cookie is left out of the exported session. */
export function isExcludedCookie(name: string): boolean {
  return isAnalyticsCookie(name) || isCloudflareCookie(name)
}

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
