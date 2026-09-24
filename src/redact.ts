/**
 * Credential redaction for anything that can end up in a terminal, a log or an issue.
 *
 * The venue's session travels as `vr-*` cookies and as a JWT (`/me` returns it as
 * `token`, next to `intercomUserJwt`). Error objects keep response bodies for
 * diagnosis, and Node's default error printer shows every field, so a schema drift on
 * `/me` would otherwise print the live token. Redacting at the source means no caller
 * has to remember to.
 */

const MASK = '***'

/** Field names whose values are credentials, wherever they appear in a body. */
const SECRET_KEY = /^(?:token|intercomuserjwt|jwt|access_token|refresh_token|cookies?|claims)$/i

/** Redact credential shapes in free text: cookie headers, session cookies, JWTs. */
export function redactText(text: string): string {
  return text
    .replace(/\bcookie:\s*[^\r\n]*/gi, `cookie: ${MASK}`)
    .replace(/\b(vr-[A-Za-z0-9_-]*)=[^;\s"']+/g, `$1=${MASK}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, MASK)
    .replace(
      /"(token|intercomUserJwt|jwt|access_token|refresh_token|cookies?|claims)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
      `"$1":"${MASK}"`,
    )
}

/**
 * Redact a parsed body: string values under credential-named keys are masked, and
 * every other string goes through {@link redactText}. Returns a copy; never mutates.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value)
  if (depth > 32 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SECRET_KEY.test(key) && typeof v === 'string' && v !== '' ? MASK : redactValue(v, depth + 1)
  }
  return out
}
