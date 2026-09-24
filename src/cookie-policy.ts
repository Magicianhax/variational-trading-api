/**
 * Which cookies are NOT part of a Variational session. One list, used by both the
 * client (`cleanCookieHeader`) and the browser extension, so the same browser session
 * exported either way yields the same cookie header.
 *
 * Pure and dependency-free on purpose: the extension bundles this file for the browser.
 *
 * This is a *denylist*, not a `vr-*` allowlist: if the venue adds or renames a session
 * cookie, an allowlist would silently drop the credential while a denylist keeps working.
 * The list only matches vendor cookie names that cannot plausibly be a first-party
 * session.
 *
 * - Cloudflare's cookies are bound to the client and network that earned them.
 *   Replayed from another process, a stale `__cf_bm` marks every request as suspicious
 *   and draws a challenge instead of helping, so they are dropped rather than forwarded.
 * - Analytics cookies carry nothing the API reads. Dropping them keeps a pasted header
 *   short enough for an env var and keeps third-party identifiers out of a file that may
 *   be copied between machines.
 */

/** Exact analytics/marketing cookie names (case-sensitive, as vendors set them). */
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
  // `_ga`, `_ga_<id>`, `_gac_*`, `_gat`, `_gat_<id>`: every Google Analytics family.
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

/** True when a cookie is not part of the session and is never exported or sent. */
export function isExcludedCookie(name: string): boolean {
  return isAnalyticsCookie(name) || isCloudflareCookie(name)
}
