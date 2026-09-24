/**
 * Minimal, dependency-free JWT *claims* reader.
 *
 * The extension never verifies a signature and never trusts these claims for any
 * security decision — it only uses them to (a) tell the user which address the
 * session belongs to and (b) record when it expires. Whoever consumes the
 * exported session re-validates it against `GET /me`.
 *
 * The `/me` token carries `address`, `exp` and `scope`; `scope` is either a
 * space-separated string or an array, and both forms are seen in the wild.
 */

export interface OmniJwtClaims {
  readonly address: string | null
  /** Unix seconds, or null when the token carries no `exp`. */
  readonly exp: number | null
  /** Space-joined scope string, or null. */
  readonly scope: string | null
}

const EMPTY_CLAIMS: OmniJwtClaims = { address: null, exp: null, scope: null }

function base64UrlToBytes(input: string): Uint8Array | null {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function readScope(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim()
  if (Array.isArray(raw)) {
    const parts = raw.filter((p): p is string => typeof p === 'string')
    return parts.length > 0 ? parts.join(' ') : null
  }
  return null
}

/**
 * Decode the payload segment of a JWT. Returns all-null claims for anything
 * that is not a well-formed three-segment JWT with a JSON object payload —
 * a malformed token is never a reason to throw inside the service worker.
 */
export function decodeJwtClaims(token: string): OmniJwtClaims {
  if (token === '') return EMPTY_CLAIMS
  const segments = token.split('.')
  if (segments.length !== 3) return EMPTY_CLAIMS
  const payloadSegment = segments[1]
  if (payloadSegment === undefined || payloadSegment === '') return EMPTY_CLAIMS

  const bytes = base64UrlToBytes(payloadSegment)
  if (bytes === null) return EMPTY_CLAIMS

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return EMPTY_CLAIMS
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_CLAIMS

  const record = parsed as Record<string, unknown>
  const rawAddress = record['address']
  const rawExp = record['exp']

  return {
    address: typeof rawAddress === 'string' && rawAddress !== '' ? rawAddress : null,
    exp: typeof rawExp === 'number' && Number.isFinite(rawExp) ? rawExp : null,
    scope: readScope(record['scope']),
  }
}
