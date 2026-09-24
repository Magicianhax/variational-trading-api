/**
 * A `FetchLike` backed by the system `curl` binary.
 *
 * WHY THIS EXISTS
 * ---------------
 * Cloudflare fronts `https://omni.variational.io/api` with a managed challenge that
 * scores the client's **TLS fingerprint**, not just its headers. Measured 2026-08-13
 * against `GET /api/metadata/config` from a residential IP:
 *
 *   | client                        | headers                  | result |
 *   | ----------------------------- | ------------------------ | ------ |
 *   | curl                          | none                     | 403    |
 *   | curl                          | Chrome `User-Agent`      | 200    |
 *   | node `fetch` (undici)         | full Chrome header set   | 403    |
 *   | node `https` + Chrome ciphers | full Chrome header set   | 403    |
 *
 * Node's TLS stack cannot pass, with any headers and with Chrome's cipher and
 * sigalg ordering. `curl`'s can, provided a browser `User-Agent` is present. So
 * Node cannot reach Variational through its own HTTP client at all, and this
 * shim is not an optimisation — without it every request 403s before it reaches the
 * venue.
 *
 * `curl` is chosen over `curl-impersonate` because it is already present on every
 * Linux box and most dev machines, needs no native build, and currently passes. If
 * Cloudflare tightens further, swap `CURL_BIN` for a `curl-impersonate` build: the
 * argument construction is deliberately compatible.
 *
 * Cost is one process spawn per request (~10-30 ms) — negligible next to the rate
 * limiter's budget and to the 0.1 s cadence the venue evaluates triggers at.
 */

import { execFile } from 'node:child_process'
import { BROWSER_USER_AGENT, type FetchLike } from './http.js'

/** Overridable so a `curl-impersonate` build can be dropped in via env. */
const CURL_BIN = process.env['CURL_BIN'] ?? 'curl'

/** Max response bytes accepted from a single call. `/metadata/stats` is ~1.5 MB. */
const MAX_BUFFER = 32 * 1024 * 1024

const HEADER_DELIMITER = '\r\n'

/**
 * Parses curl's `-D -` header block. curl emits one block per response, so a
 * redirect chain yields several; the LAST block is the one describing the body we
 * were handed.
 */
function parseHeaderBlocks(raw: string): { status: number; headers: Headers } {
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  const last = blocks[blocks.length - 1] ?? ''
  const lines = last.split(/\r?\n/)
  const statusLine = lines[0] ?? ''
  const status = Number.parseInt(statusLine.split(' ')[1] ?? '0', 10)

  const headers = new Headers()
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    // Multiple Set-Cookie headers must all survive; Headers.append handles that.
    headers.append(name, value)
  }
  return { status: Number.isFinite(status) && status > 0 ? status : 0, headers }
}

function headerEntries(init: RequestInit): Array<[string, string]> {
  const h = init.headers
  if (h === undefined) return []
  if (h instanceof Headers) return [...h.entries()]
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)])
  return Object.entries(h as Record<string, string>).map(([k, v]) => [k, String(v)])
}

/**
 * Builds the argv for one request. Exported so the header-ordering rule below can be
 * asserted in tests without spawning a process or touching the network — the rule is
 * invisible to the type system and its failure mode is a silent 403.
 */
export function buildCurlArgs(url: string, init: RequestInit, timeoutMs: number): string[] {
  const method = (init.method ?? 'GET').toUpperCase()
  const entries = headerEntries(init)

  const args = [
    '--silent',
    '--show-error',
    '--dump-header',
    '-',
    '--max-time',
    String(Math.ceil(timeoutMs / 1000)),
    // Never follow a redirect: an auth endpoint bouncing us somewhere unexpected must
    // surface as a status, not be transparently chased.
    '--no-location',
    '--request',
    method,
  ]

  // The UA MUST go through `--user-agent`, never `--header`. curl emits `--header`
  // values after its own default header block, so passing the UA that way puts it in a
  // position no browser would use — and Cloudflare fingerprints header ORDER, not just
  // header values. Measured on GET /api/metadata/config, five runs each:
  //
  //   --header 'user-agent: <Chrome UA>'  -> 403 403 403 403 403
  //   --user-agent '<Chrome UA>'          -> 200 200 200 200 200
  //
  // Identical URL, identical header values. Only the ordering differed.
  const userAgent =
    entries.find(([k]) => k.toLowerCase() === 'user-agent')?.[1] ?? BROWSER_USER_AGENT
  args.push('--user-agent', userAgent)

  for (const [name, value] of entries) {
    // Already sent via --user-agent above; re-sending would duplicate the header.
    if (name.toLowerCase() === 'user-agent') continue
    // curl sends `Accept: */*`, as a browser does. Overriding it to application/json
    // reliably draws a challenge (403 on five of five runs), so refuse to set it.
    if (name.toLowerCase() === 'accept') continue
    args.push('--header', `${name}: ${value}`)
  }

  const body = init.body
  if (body !== undefined && body !== null) {
    if (typeof body !== 'string') {
      throw new TypeError(`curl transport supports string bodies only, received ${typeof body}`)
    }
    // `--data-raw` so a leading '@' in a body is never read as a filename.
    args.push('--data-raw', body)
  }

  args.push('--url', url)
  return args
}

/**
 * Anything that looks like a credential, wherever it came from.
 *
 * `cookie:` headers and JWTs are the two shapes the venue session takes on the wire.
 * This is the belt to the braces below: the message is already assembled from safe
 * parts, and this catches anything a future code path lets through.
 */
function scrubSecrets(text: string): string {
  return text
    .replace(/\bcookie:\s*[^\r\n]*/gi, 'cookie: ***')
    .replace(/\b(vr-token[^=\s]*|vr-connected-address)=\S+/gi, '$1=***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***')
}

/**
 * The message for a curl transport failure, built from safe parts ONLY.
 *
 * The session is a credential and must never reach a log line.
 * curl runs under execFile, and Node composes its failure message as
 * "Command failed: <bin> <every arg>" -- and the args carry
 * `--header cookie: vr-token=<JWT>`. That string became the circuit breaker's
 * `lastReason`, which `/health` returns and the WebSocket broadcasts, so a single DNS
 * blip put the live session JWT into the browser, the audit log, and any screenshot of
 * the terminal.
 *
 * So `error.message` is never used. What curl printed on stderr is the diagnostic that
 * actually matters ("Could not resolve host"), and the exit code covers the silent case.
 */
export function transportErrorMessage(
  bin: string,
  method: string,
  url: string,
  error: unknown,
  stderr: string,
): string {
  const err = (error ?? {}) as { code?: unknown; signal?: unknown; killed?: unknown }
  const printed = scrubSecrets(stderr.trim())
  const parts: string[] = []
  if (printed !== '') parts.push(printed)
  if (err.killed === true) parts.push('killed')
  if (typeof err.signal === 'string' && err.signal !== '') parts.push(`signal ${err.signal}`)
  if (typeof err.code === 'number') parts.push(`exit code ${err.code}`)
  else if (typeof err.code === 'string' && err.code !== '') parts.push(err.code)
  if (parts.length === 0) parts.push('no diagnostic output')
  // `bin` and `url` are safe: the credential travels in a header, never the URL.
  return `curl transport failed (${bin} ${method} ${url}): ${parts.join('; ')}`
}

export type CurlTransportOptions = {
  /** Hard ceiling per request. The caller's AbortSignal still applies on top. */
  timeoutMs?: number
  /** Overrides the binary; useful for pointing at `curl-impersonate`. */
  bin?: string
}

/**
 * Builds a `FetchLike` that shells out to curl.
 *
 * Semantics deliberately match `fetch` where the client relies on them: a non-2xx
 * status RESOLVES (it does not throw), `response.text()` yields the raw body, and
 * `response.headers.getSetCookie()` yields every `Set-Cookie`. A transport failure
 * (spawn error, timeout, DNS) rejects, which `OmniHttp` maps to `TransportError`.
 */
export function createCurlTransport(options: CurlTransportOptions = {}): FetchLike {
  const bin = options.bin ?? CURL_BIN
  const timeoutMs = options.timeoutMs ?? 30_000

  return function curlFetch(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()

    let args: string[]
    try {
      args = buildCurlArgs(url, init, timeoutMs)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }

    return new Promise<Response>((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort)
          if (error) {
            reject(new Error(transportErrorMessage(bin, method, url, error, stderr)))
            return
          }

          // Header block and body are both on stdout; split at the blank line that
          // terminates the FINAL header block.
          const marker = `${HEADER_DELIMITER}${HEADER_DELIMITER}`
          let splitAt = stdout.lastIndexOf(marker)
          let skip = marker.length
          if (splitAt < 0) {
            splitAt = stdout.lastIndexOf('\n\n')
            skip = 2
          }
          if (splitAt < 0) {
            reject(new Error(`curl transport: no header/body boundary in response from ${url}`))
            return
          }

          const rawHeaders = stdout.slice(0, splitAt)
          const rawBody = stdout.slice(splitAt + skip)
          const { status, headers } = parseHeaderBlocks(rawHeaders)

          if (status === 0) {
            reject(new Error(`curl transport: unparseable status line from ${url}`))
            return
          }

          // 204/304 must carry no body or the Response constructor throws.
          const nullBody = status === 204 || status === 205 || status === 304
          resolve(new Response(nullBody ? null : rawBody, { status, headers }))
        },
      )

      const signal = init.signal ?? undefined
      const onAbort = (): void => {
        child.kill()
        reject(new Error(`curl transport: aborted (${method} ${url})`))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          child.kill()
          reject(new Error(`curl transport: aborted before start (${method} ${url})`))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

/** Shared default instance — one spawn per request, no state to share. */
export const curlTransport: FetchLike = createCurlTransport()
