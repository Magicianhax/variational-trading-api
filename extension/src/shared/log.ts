/**
 * Logging helpers.
 *
 * An extension's console is readable from `chrome://extensions` and routinely
 * pasted into bug reports, so no credential ever goes through these functions —
 * callers log digests ({@link shortDigest}) and counts, never values.
 */

const PREFIX = '[session-exporter]'

/** First 12 hex chars of a fingerprint digest — safe to display and to log. */
export function shortDigest(digest: string | null): string {
  if (digest === null || digest === '') return '—'
  return digest.slice(0, 12)
}

export function logInfo(message: string, detail?: Record<string, unknown>): void {
  if (detail === undefined) console.info(`${PREFIX} ${message}`)
  else console.info(`${PREFIX} ${message}`, detail)
}

export function logWarn(message: string, detail?: Record<string, unknown>): void {
  if (detail === undefined) console.warn(`${PREFIX} ${message}`)
  else console.warn(`${PREFIX} ${message}`, detail)
}

/** Normalise a thrown value into a message that is safe to surface in the UI. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'Request timed out.'
      : error.message
  }
  if (typeof error === 'string') return error
  return 'Unknown error.'
}
