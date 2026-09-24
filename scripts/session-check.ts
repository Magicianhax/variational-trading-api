/**
 * Is my session alive? Signs in with a saved session, asks the venue who it is, and says
 * how long the session has left. Read-only: one GET /me, nothing else.
 *
 *   pnpm session:check                 # ./session.json, else VARIATIONAL_COOKIES
 *   pnpm session:check path/to/session.json
 *
 * Exits non-zero when there is no session, when it has expired, or when the venue
 * rejects it -- so it can gate a script or a cron job. Never prints a cookie or token
 * value: this output gets pasted into issues and chat.
 */

import { existsSync } from 'node:fs'
import {
  isApiError,
  isAuthError,
  isRateLimitError,
  loadSession,
  OmniClient,
  type SessionBundle,
  TransportError,
} from '../dist/index.js'
import { loadEnv } from '../examples/_env.ts'

const HOW_TO_GET_ONE = [
  'Get a session one of three ways (docs/AUTH.md):',
  '  1. Browser extension: `pnpm build:extension`, load extension/dist unpacked',
  '     (docs/EXTENSION.md), sign in on omni.variational.io, click',
  '     "Download session.json" and save it in the repo root.',
  '  2. DevTools: copy the Cookie header from any request to omni.variational.io/api',
  '     and put it in VARIATIONAL_COOKIES (in .env or the environment).',
  '  3. Optional, EOA wallets only: sign in with a private key via SIWE',
  '     (examples/login-with-private-key.ts).',
].join('\n')

function fail(message: string, hint?: string): never {
  console.error(`\nsession check FAILED: ${message}`)
  if (hint !== undefined) console.error(`\n${hint}`)
  console.error('')
  process.exit(1)
}

/** "3d 4h 12m" -- a session lasts about a week, so seconds would be noise. */
function remaining(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Where the session comes from, in the documented order. The label never holds a secret. */
function findSource(): { source: string; label: string } {
  const arg = process.argv[2]
  if (arg !== undefined && arg !== '') {
    if (!existsSync(arg)) fail(`no file at ${arg}`, HOW_TO_GET_ONE)
    return { source: arg, label: arg }
  }
  if (existsSync('session.json')) return { source: 'session.json', label: './session.json' }
  loadEnv()
  const env = process.env['VARIATIONAL_COOKIES']?.trim()
  if (env) return { source: env, label: 'VARIATIONAL_COOKIES' }
  return fail(
    'no session found (no ./session.json, VARIATIONAL_COOKIES is not set).',
    HOW_TO_GET_ONE,
  )
}

async function main(): Promise<void> {
  const { source, label } = findSource()

  let session: SessionBundle
  try {
    session = loadSession(source)
  } catch (err) {
    fail(`${label}: ${err instanceof Error ? err.message : String(err)}`, HOW_TO_GET_ONE)
  }

  // A saved expiry is checked locally first: no point spending a request on a dead session.
  if (session.expiresAt !== undefined && session.expiresAt <= Date.now()) {
    fail(
      `the session in ${label} expired at ${new Date(session.expiresAt).toISOString()}.`,
      `Sessions last about 7 days. Export a fresh one.\n\n${HOW_TO_GET_ONE}`,
    )
  }

  // dryRun stays on: this script only reads, and must stay unable to do anything else.
  const client = OmniClient.fromSession(session, { dryRun: true })
  try {
    const me = await client.getMe()
    if (me.token === '') {
      fail(
        `the venue did not accept the session in ${label} (signed out or expired).`,
        `Export a fresh one while signed in.\n\n${HOW_TO_GET_ONE}`,
      )
    }
  } catch (err) {
    if (isAuthError(err)) fail(`the venue rejected the session in ${label} (401).`, HOW_TO_GET_ONE)
    if (isRateLimitError(err))
      fail(
        `rate limited by the venue (HTTP ${err.status}).`,
        err.status === 418
          ? 'HTTP 418 is a temporary ban. Wait before retrying (docs/ACCESS.md).'
          : 'Wait a minute and retry.',
      )
    if (isApiError(err) && err.headers['cf-mitigated'] === 'challenge')
      fail(
        'blocked by a Cloudflare challenge before reaching the venue.',
        'This is about the network or TLS fingerprint, not your session: datacenter IPs and\n' +
          "Node's own HTTP client are refused. See docs/ACCESS.md.",
      )
    if (isApiError(err))
      fail(`the venue answered GET /me with HTTP ${err.status}.`, 'See docs/ACCESS.md.')
    if (err instanceof TransportError)
      fail(
        `could not reach the venue: ${err.message}`,
        'The client shells out to curl; check that curl is installed and on PATH (docs/ACCESS.md).',
      )
    /*
     * Name and message only. Rethrowing would let Node print the error's own fields, and
     * a SchemaDriftError on /me carries the raw response body -- which holds the token.
     */
    fail(err instanceof Error ? `${err.name}: ${err.message}` : 'unexpected error')
  }

  const claims = client.decodeToken()
  const address = claims?.address ?? session.address ?? client.getConnectedAddress()
  const expiresAt = claims?.exp === undefined ? session.expiresAt : claims.exp * 1000

  console.log(`\nsession OK (${label})`)
  console.log(`  signed in as  ${address ?? 'unknown (the token carries no address)'}`)
  if (expiresAt === undefined) {
    console.log('  expires       unknown')
  } else {
    console.log(`  expires       ${new Date(expiresAt).toISOString()}`)
    console.log(`  time left     ${remaining(expiresAt - Date.now())}`)
  }
  if (claims?.scope !== undefined) {
    const scope = Array.isArray(claims.scope) ? claims.scope.join(' ') : claims.scope
    // A transfer:none session can trade but cannot deposit or withdraw.
    console.log(`  scope         ${scope}`)
  }
  console.log('')
}

await main()
