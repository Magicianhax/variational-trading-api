/**
 * Getting a session INTO the client, from whatever form a person actually has it in.
 *
 * A session is the venue's own HttpOnly cookies (the `vr-*` ones). That is all a
 * client needs: the JWT is optional, because `getMe()` derives it from the cookies. So
 * the forms accepted here are the ones people end up holding -- a session.json written
 * by the browser extension or by SIWE login, the same JSON pasted into an env var, or
 * the raw `Cookie:` header copied out of DevTools.
 *
 * Nothing in this module logs, and no error message it throws echoes a cookie or token
 * value: the input is a credential, and error text ends up in terminals and screenshots.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isExcludedCookie } from './cookie-policy.js'
import type { SessionBundle } from './session-bundle.js'

/**
 * Normalise a `Cookie` header copied from a browser: strip a leading `cookie:` label
 * and wrapping quotes, drop Cloudflare and analytics cookies, keep everything else in
 * the order given. Returns `''` when nothing survives.
 */
export function cleanCookieHeader(header: string): string {
  // "Copy as cURL" and DevTools both hand out the header with quotes around it at times.
  const text = unquote(header).replace(/^cookie\s*:/i, '')

  const kept: string[] = []
  // Split on newlines too: a header pasted from a wrapped DevTools pane can carry them.
  for (const raw of text.split(/[;\r\n]/)) {
    const pair = raw.trim()
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    // One denylist shared with the browser extension: src/cookie-policy.ts.
    if (name === '' || isExcludedCookie(name)) continue
    kept.push(`${name}=${pair.slice(eq + 1).trim()}`)
  }
  return kept.join('; ')
}

/**
 * Load a session from any of the forms a person is likely to have:
 *
 * - a `SessionBundle` object (used as-is, then cleaned);
 * - a JSON string of one (e.g. the contents of session.json pasted into an env var);
 * - a path to a session.json file;
 * - a raw `Cookie:` header value copied from the browser.
 *
 * The result's cookies are always cleaned with `cleanCookieHeader`. Throws, without
 * echoing any secret, when no usable cookies remain.
 */
export function loadSession(source: string | SessionBundle): SessionBundle {
  if (typeof source !== 'string') return normalise(source, 'session object')

  // A value from a .env file or a shell often arrives wrapped in quotes; without this a
  // quoted JSON session fails the `{` check below and is misread as a cookie header.
  const text = unquote(source)
  if (text === '') throw new Error(`${NO_SESSION} The session source is empty.`)
  if (text.startsWith('{')) return normalise(parseJson(text, 'session JSON'), 'session JSON')
  if (isFile(text)) return normalise(parseJson(readFileSync(text, 'utf8'), text), text)

  /*
   * A cookie header always has a `name=value` pair. Without one this was almost
   * certainly meant as a file path that does not exist -- say that, rather than the
   * baffling "no cookies" it would otherwise produce. Echo the path only when it looks
   * like one, so a mistakenly pasted bare token never lands in an error message.
   */
  if (!text.includes('=')) {
    const looksLikePath = /\.json$/i.test(text) && text.length < 512
    throw new Error(
      looksLikePath
        ? `No session file at "${text}". ${GET_ONE}`
        : `${NO_SESSION} The value is neither a session file path nor a Cookie header. ${GET_ONE}`,
    )
  }

  const cookies = cleanCookieHeader(text)
  if (cookies === '') throw new Error(`${NO_SESSION} ${EMPTY_COOKIES}`)
  // The JWT is minted from the cookies by getMe(); an empty token means "not fetched yet".
  return { token: '', cookies }
}

const NO_SESSION = 'No usable Variational session.'
const GET_ONE =
  'Export one (docs/AUTH.md) or set VARIATIONAL_COOKIES, then run `pnpm session:check`.'

/** Trim, then remove ONE pair of matching wrapping quotes. */
function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0])
    return text.slice(1, -1).trim()
  return text
}
const EMPTY_COOKIES =
  'The cookie header has no cookies left after dropping Cloudflare and analytics ones -- ' +
  'copy it from a request to omni.variational.io/api while signed in (the vr-* cookies are the session).'

function isFile(path: string): boolean {
  // A long cookie header can exceed the OS path limit, and statSync throws on that.
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // The parser's own message quotes the input around the error position -- a secret.
    throw new Error(`${NO_SESSION} ${label} is not valid JSON.`)
  }
}

function normalise(value: unknown, label: string): SessionBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${NO_SESSION} ${label} is not a session object.`)
  const raw = value as Record<string, unknown>
  const field = (name: string): unknown => raw[name]

  const token = field('token')
  if (token !== undefined && typeof token !== 'string')
    throw new Error(`${NO_SESSION} ${label}: "token" must be a string.`)
  const rawCookies = field('cookies')
  if (rawCookies !== undefined && typeof rawCookies !== 'string')
    throw new Error(`${NO_SESSION} ${label}: "cookies" must be a Cookie header string.`)

  // Auth is the cookie: a token alone authenticates nothing on the REST API.
  const cookies = typeof rawCookies === 'string' ? cleanCookieHeader(rawCookies) : ''
  if (cookies === '')
    throw new Error(
      `${NO_SESSION} ${label} has no cookies. ${rawCookies === undefined ? 'Export a fresh session (docs/AUTH.md).' : EMPTY_COOKIES}`,
    )

  const bundle: SessionBundle = { token: typeof token === 'string' ? token.trim() : '', cookies }
  const address = field('address')
  if (typeof address === 'string' && address !== '') bundle.address = address
  const userAgent = field('userAgent')
  if (typeof userAgent === 'string' && userAgent !== '') bundle.userAgent = userAgent

  const expiresAt = field('expiresAt')
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) bundle.expiresAt = expiresAt
  else {
    // So a caller can warn about a dead session before spending a request on it.
    const exp = jwtExpiry(bundle.token)
    if (exp !== undefined) bundle.expiresAt = exp * 1000
  }
  return bundle
}

/**
 * The `exp` claim (epoch seconds) of a JWT, unverified. The venue is the validator;
 * this only needs to know when to stop trusting a saved session.
 */
function jwtExpiry(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined || payload === '') return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims !== 'object' || claims === null) return undefined
    const exp = (claims as Record<string, unknown>)['exp']
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined
  } catch {
    return undefined
  }
}
