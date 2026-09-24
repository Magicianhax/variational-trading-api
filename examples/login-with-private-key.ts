/**
 * OPTIONAL, ADVANCED. You do not need this to use the client: a session exported from
 * the browser (the extension, or a Cookie header from DevTools) is all it needs, and
 * never puts your wallet key on disk. See docs/AUTH.md.
 *
 * This signs in with a wallet private key instead (SIWE) and saves the session to
 * ./session.json:
 *
 *   VARIATIONAL_PRIVATE_KEY=0x... pnpm example examples/login-with-private-key.ts
 *
 * EOA wallets only: a smart-contract wallet cannot produce this signature. Whoever holds
 * the key holds the funds, so prefer the browser session. Run it from a home connection:
 * login from a datacenter IP is challenged by Cloudflare.
 *
 * session.json is a credential. It is git-ignored; keep it that way.
 */
import { writeFileSync } from 'node:fs'
import { curlTransport, loadSession, mintSessionViaSiwe, OmniClient } from '../dist/index.js'
import { loadEnv } from './_env.ts'

loadEnv()
const key = process.env['VARIATIONAL_PRIVATE_KEY']?.trim()
if (!key) throw new Error('set VARIATIONAL_PRIVATE_KEY (in .env or the environment)')

const client = new OmniClient({ fetchImpl: curlTransport })
// loadSession adds expiresAt from the JWT, so session.json matches the extension's export.
const bundle = loadSession(await mintSessionViaSiwe(client, key))

writeFileSync('session.json', JSON.stringify(bundle, null, 2), { mode: 0o600 })
// Never print the token or cookies.
console.log('logged in as', bundle.address)
console.log(
  'expires',
  bundle.expiresAt === undefined ? 'unknown' : new Date(bundle.expiresAt).toISOString(),
)
console.log('saved to session.json')
