import { describe, expect, it } from 'vitest'
import { buildCurlArgs, transportErrorMessage } from '../src/curl-transport.js'
import { BROWSER_USER_AGENT } from '../src/http.js'

/**
 * These assertions encode a rule that is invisible to the type system and whose failure
 * mode is a silent Cloudflare 403 on every single request — i.e. a client that cannot
 * reach the venue at all, including to close a position.
 *
 * Measured live against GET https://omni.variational.io/api/metadata/config, 2026-08-13,
 * five runs per variant:
 *
 *   node fetch (undici), full browser headers      -> 403 (TLS fingerprint)
 *   curl, no User-Agent                            -> 403
 *   curl, UA via --header                          -> 403 403 403 403 403
 *   curl, UA via --user-agent                      -> 200 200 200 200 200
 *   curl, UA via --user-agent + accept: app/json   -> 403 403 403 403 403
 */
describe('buildCurlArgs — Cloudflare header-order rules', () => {
  const url = 'https://omni.variational.io/api/metadata/config'

  function pairs(args: string[], flag: string): string[] {
    const out: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1] as string)
    }
    return out
  }

  it('sends the User-Agent via --user-agent, never via --header', () => {
    const args = buildCurlArgs(
      url,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
      30_000,
    )

    expect(pairs(args, '--user-agent')).toEqual([BROWSER_USER_AGENT])
    expect(pairs(args, '--header').some((h) => h.toLowerCase().startsWith('user-agent'))).toBe(
      false,
    )
  })

  it('routes a caller-supplied User-Agent through --user-agent too, without duplicating it', () => {
    const args = buildCurlArgs(
      url,
      { method: 'GET', headers: { 'user-agent': 'custom-shim/1.0', 'x-thing': 'a' } },
      30_000,
    )

    expect(pairs(args, '--user-agent')).toEqual(['custom-shim/1.0'])
    expect(pairs(args, '--header')).toEqual(['x-thing: a'])
  })

  it('never sets an Accept header, which draws a challenge', () => {
    const args = buildCurlArgs(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
      },
      30_000,
    )

    expect(pairs(args, '--header').some((h) => h.toLowerCase().startsWith('accept'))).toBe(false)
    expect(pairs(args, '--header')).toContain('content-type: application/json')
  })

  it('passes a POST body via --data-raw so a leading @ is not read as a filename', () => {
    const body = '@{"address":"0xabc"}'
    const args = buildCurlArgs(url, { method: 'POST', body }, 30_000)

    expect(pairs(args, '--data-raw')).toEqual([body])
    expect(pairs(args, '--request')).toEqual(['POST'])
    expect(args).not.toContain('--data')
  })

  it('never follows redirects', () => {
    expect(buildCurlArgs(url, { method: 'GET' }, 30_000)).toContain('--no-location')
  })

  it('rejects a non-string body rather than silently sending nothing', () => {
    expect(() =>
      buildCurlArgs(url, { method: 'POST', body: new Uint8Array([1, 2]) as unknown as string }, 1),
    ).toThrow(TypeError)
  })

  it('converts the timeout to whole seconds, rounding up so it is never zero', () => {
    expect(pairs(buildCurlArgs(url, { method: 'GET' }, 1), '--max-time')).toEqual(['1'])
    expect(pairs(buildCurlArgs(url, { method: 'GET' }, 1500), '--max-time')).toEqual(['2'])
    expect(pairs(buildCurlArgs(url, { method: 'GET' }, 30_000), '--max-time')).toEqual(['30'])
  })
})

describe('transportErrorMessage — never leaks the session out of the process', () => {
  /*
   * The session is a credential and must never leave the process in a log line.
   * An error message once did exactly that.
   *
   * curl is invoked with execFile, and Node builds a failure message of the form
   * "Command failed: <bin> <every arg>". The args carry `--header cookie: vr-token=<JWT>`.
   * That string became the circuit breaker's `lastReason`, which /health returns and the
   * WebSocket broadcasts -- so a DNS blip put the live session JWT in the browser, in the
   * audit log, and in any screenshot of the terminal.
   *
   * The message must therefore be built from safe parts only: what curl printed, and how
   * it exited. Never the command line.
   */
  const COOKIE = 'vr-token=eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIGNATURE'
  const execError = Object.assign(
    new Error(
      `Command failed: curl --silent --request GET --header cookie: ${COOKIE} --url https://omni.variational.io/api/positions`,
    ),
    { code: 6 },
  )

  it('keeps the session token out of the message entirely', () => {
    const msg = transportErrorMessage(
      'curl',
      'GET',
      'https://omni.variational.io/api/positions',
      execError,
      'curl: (6) Could not resolve host: omni.variational.io',
    )
    expect(msg).not.toContain(COOKIE)
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(msg).not.toContain('cookie')
  })

  it('still says what actually went wrong', () => {
    const msg = transportErrorMessage(
      'curl',
      'GET',
      'https://omni.variational.io/api/positions',
      execError,
      'curl: (6) Could not resolve host: omni.variational.io',
    )
    // A DNS failure must still be diagnosable from this string alone.
    expect(msg).toContain('Could not resolve host')
    expect(msg).toContain('GET')
    expect(msg).toContain('/positions')
  })

  it('falls back to the exit code when curl printed nothing', () => {
    const msg = transportErrorMessage(
      'curl',
      'GET',
      'https://omni.variational.io/api/positions',
      execError,
      '',
    )
    expect(msg).not.toContain(COOKIE)
    expect(msg).toMatch(/exit code 6|code 6/i)
  })

  it('scrubs a token even if one reaches it by another route', () => {
    // Defence in depth: stderr is curl's own output and should be clean, but if a future
    // curl build ever echoed the request back, the redaction still has to hold.
    const msg = transportErrorMessage(
      'curl',
      'GET',
      'https://omni.variational.io/api/x',
      execError,
      `something ${COOKIE} leaked`,
    )
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIGNATURE')
  })
})
