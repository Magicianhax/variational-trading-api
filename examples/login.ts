/**
 * Programmatic login (SIWE) → a session bundle saved to ./session.json.
 *
 *   VARIATIONAL_PRIVATE_KEY=0x... npm run example examples/login.ts
 *
 * Only an EOA key works — a smart-contract wallet cannot produce this signature; copy
 * cookies from the browser instead (docs/AUTH.md). Run it from a home connection: login
 * from a datacenter IP is challenged by Cloudflare.
 *
 * session.json is a credential. It is git-ignored; keep it that way.
 */
import { writeFileSync } from 'node:fs'
import { curlTransport, mintSessionViaSiwe, OmniClient } from '../dist/index.js'
import { loadEnv } from './_env.ts'

loadEnv()
const key = process.env['VARIATIONAL_PRIVATE_KEY']?.trim()
if (!key) throw new Error('set VARIATIONAL_PRIVATE_KEY (in .env or the environment)')

const client = new OmniClient({ fetchImpl: curlTransport })
const bundle = await mintSessionViaSiwe(client, key)

writeFileSync('session.json', JSON.stringify(bundle, null, 2), { mode: 0o600 })
// Never print the token or cookies.
console.log('logged in as', bundle.address)
console.log(
  'expires',
  bundle.expiresAt === undefined ? 'unknown' : new Date(bundle.expiresAt).toISOString(),
)
console.log('saved to session.json')
