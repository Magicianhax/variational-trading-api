/**
 * Settings, and validation of the optional push-server URL.
 *
 * Settings live in `chrome.storage.local` — deliberately NOT `storage.sync`,
 * because the server token is a bearer secret and `sync` would replicate it to
 * every browser signed into the same Google account.
 */

// `zod/mini` rather than `zod`: it tree-shakes, which keeps each bundled entry
// point small; the full build ships the whole library into the popup and worker.
import * as z from 'zod/mini'

export const SettingsSchema = z.object({
  /**
   * Off by default: exporting (copy / download) needs no server at all. Push is
   * for people who run their own process and want the session delivered to it.
   */
  pushEnabled: z.boolean(),
  /** Server base URL, e.g. `https://bot.example.com` or `http://127.0.0.1:8080`. */
  serverUrl: z.string(),
  /** Sent as `Authorization: Bearer <token>` — never in a query string, where logs keep it. */
  serverToken: z.string(),
  /** Push whenever the session changes, not only on "Push now". */
  autoPush: z.boolean(),
  /** Periodic re-check cadence while push is on, minutes. */
  refreshMinutes: z.int().check(z.gte(1), z.lte(360)),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  pushEnabled: false,
  serverUrl: '',
  serverToken: '',
  autoPush: true,
  refreshMinutes: 5,
}

/** Parse persisted settings, falling back to defaults field-by-field. */
export function parseSettings(raw: unknown): Settings {
  const parsed = SettingsSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const record = raw as Record<string, unknown>
  const merged = { ...DEFAULT_SETTINGS, ...record }
  const second = SettingsSchema.safeParse(merged)
  return second.success ? second.data : { ...DEFAULT_SETTINGS }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

export interface ServerTarget {
  /** Base URL with no trailing slash, e.g. `https://bot.example.com/api`. */
  readonly base: string
  /** `chrome.permissions` match pattern covering the server host, any port. */
  readonly originPattern: string
  /** Human-readable origin, e.g. `https://bot.example.com:8443`. */
  readonly origin: string
  /** True when the transport is plaintext HTTP on loopback (allowed). */
  readonly loopback: boolean
}

export type ServerTargetResult =
  | { readonly ok: true; readonly target: ServerTarget }
  | { readonly ok: false; readonly error: string }

/**
 * Validate and normalise the configured server URL.
 *
 * Policy: HTTPS everywhere, with one exception — plaintext HTTP to `localhost`
 * or `127.0.0.1`, which never leaves the machine. Anything else would put a live
 * session and a bearer token on the wire in clear text.
 */
export function resolveServerTarget(raw: string): ServerTargetResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: 'Server URL is not set.' }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Server URL is not a valid absolute URL.' }
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'Server URL must not embed credentials.' }
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'Server URL must not contain a query string or fragment.' }
  }

  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol === 'http:' && !loopback) {
    return {
      ok: false,
      error:
        'Server URL must use https:// (plain http:// is allowed only for localhost/127.0.0.1).',
    }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `Unsupported scheme "${url.protocol}" — use https://.` }
  }

  const path = url.pathname.replace(/\/+$/, '')
  return {
    ok: true,
    target: {
      base: `${url.origin}${path}`,
      originPattern: `${url.protocol}//${url.hostname}/*`,
      origin: url.origin,
      loopback: loopback && url.protocol === 'http:',
    },
  }
}
