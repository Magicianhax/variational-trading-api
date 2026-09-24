/**
 * The optional push to the user's own server.
 *
 * One call, and the whole contract a server has to implement:
 *
 *   POST {serverUrl}/session
 *   Authorization: Bearer <token>
 *   Content-Type: application/json
 *   <SessionBundle>            — the same JSON as a downloaded session.json
 *
 * Any 2xx is "accepted"; 401/403 means the bearer token was refused. A JSON body
 * of `{ "ok": false, "error": "..." }` is surfaced as a rejection so a server can
 * explain itself (e.g. "wrong account").
 *
 * Transport policy is enforced in `resolveServerTarget`: HTTPS everywhere, except
 * plaintext HTTP to loopback.
 */

import type { SessionBundle } from '../shared/bundle.js'
import { SERVER_TIMEOUT_MS } from '../shared/constants.js'
import { errorMessage } from '../shared/log.js'
import type { ServerTarget } from '../shared/settings.js'

export type PushResult =
  | { readonly kind: 'ok' }
  /** The server refused the bearer token. */
  | { readonly kind: 'unauthorized'; readonly detail: string }
  /** Reached the server, got a non-2xx that is not 401/403, or an explicit `ok: false`. */
  | { readonly kind: 'http'; readonly status: number; readonly detail: string }
  /** Never reached the server (DNS, TLS, refused, timeout). */
  | { readonly kind: 'network'; readonly detail: string }

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const trimmed = (await response.text()).trim()
    if (trimmed === '') return `HTTP ${response.status}`
    return `HTTP ${response.status}: ${trimmed.slice(0, 200)}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function explicitRejection(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (record['ok'] !== false) return null
  const reason = record['error'] ?? record['message']
  return typeof reason === 'string' && reason !== '' ? reason : 'Server rejected the session.'
}

/** `POST {base}/session` with the bundle as the body. */
export async function pushSession(
  target: ServerTarget,
  token: string,
  bundle: SessionBundle,
): Promise<PushResult> {
  let response: Response
  try {
    response = await fetch(`${target.base}/session`, {
      method: 'POST',
      cache: 'no-store',
      // The server authenticates with the bearer token alone; sending the browser's
      // cookies for that origin would leak unrelated credentials to it.
      credentials: 'omit',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    })
  } catch (error) {
    return { kind: 'network', detail: errorMessage(error) }
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: 'unauthorized', detail: `Server refused the token (HTTP ${response.status}).` }
  }
  if (!response.ok) {
    return { kind: 'http', status: response.status, detail: await readErrorDetail(response) }
  }

  // A 2xx with an empty or non-JSON body is a valid "accepted" — only parse to
  // surface an explicit `{ ok: false }`.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return { kind: 'ok' }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'ok' }
  }
  const rejection = explicitRejection(body)
  return rejection === null
    ? { kind: 'ok' }
    : { kind: 'http', status: response.status, detail: rejection }
}
