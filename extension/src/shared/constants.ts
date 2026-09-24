/**
 * Constants shared by the service worker and the popup.
 *
 * Nothing here is secret. The session and the optional server token live in
 * `chrome.storage.local` or in memory, never in the shipped bundle.
 */

/** The only venue origin the extension ever touches. */
export const OMNI_ORIGIN = 'https://omni.variational.io'

/**
 * The URL whose cookie set we export. Using a `/api/` URL (rather than the bare
 * origin) means Chrome hands back exactly the cookies it would attach to an
 * `/api` request — including any `Path=/api`-scoped cookie — and nothing else.
 */
export const OMNI_COOKIE_URL = `${OMNI_ORIGIN}/api/`

/** `GET /api/me` -> `{ token, ... }`. `token` is "" when signed out. */
export const OMNI_ME_URL = `${OMNI_ORIGIN}/api/me`

/** Match pattern for the required host permission. */
export const OMNI_HOST_PERMISSION = `${OMNI_ORIGIN}/*`

/** Cloudflare stamps this on a challenged response. */
export const CF_MITIGATED_HEADER = 'cf-mitigated'

/** chrome.alarms name for the periodic re-check (only scheduled while push is on). */
export const REFRESH_ALARM = 'session-exporter-refresh'

/** Debounce window for cookie-change-triggered refreshes. */
export const COOKIE_DEBOUNCE_MS = 3_000

/** A session whose JWT expires within this window is reported as "expiring". */
export const EXPIRY_WARN_MS = 10 * 60_000

/** Network timeout for every call to the optional push server. */
export const SERVER_TIMEOUT_MS = 10_000

/** Network timeout for the `GET /api/me` probe. */
export const OMNI_TIMEOUT_MS = 15_000

/** File name the popup downloads; the client's `session:check` looks for it by default. */
export const SESSION_FILE_NAME = 'session.json'

/** Storage keys (all in `chrome.storage.local`). */
export const STORAGE_KEYS = {
  settings: 'settings',
  status: 'status',
} as const
