/**
 * Quote, then a market order — DRY RUN unless DRY_RUN=false.
 *
 *   npm run example examples/trade.ts
 *
 * A market order needs a fresh quote id; quotes age out fast (QUOTE_MAX_AGE_MS), so
 * quote and order back to back. Slippage is passed in bps here and sent to the venue as
 * a FRACTION of 1 — the client does that conversion (docs/API.md).
 */
import { existsSync, readFileSync } from 'node:fs'
import { curlTransport, OmniClient, type SessionBundle } from '../dist/index.js'
import { isDryRun, loadEnv } from './_env.ts'

loadEnv()
const session = existsSync('session.json')
  ? (JSON.parse(readFileSync('session.json', 'utf8')) as SessionBundle)
  : undefined
const cookies = session?.cookies ?? process.env['VARIATIONAL_COOKIES']
if (!cookies) throw new Error('no session: run examples/login.ts or set VARIATIONAL_COOKIES')

const dryRun = isDryRun()
const client = new OmniClient({ fetchImpl: curlTransport, cookies, dryRun })
await client.getMe()

const instrument = { symbol: 'BTC', instrument_type: 'perpetual_future' as const }
const quote = await client.quoteIndicative({ instrument, qty: '0.0001' })
console.log('quote', quote.quote_id, 'bid', quote.bid, 'ask', quote.ask)

const ack = await client.placeMarketOrder({
  quoteId: quote.quote_id,
  side: 'Buy',
  maxSlippageBps: 20,
})
console.log(dryRun ? 'DRY RUN — nothing was sent:' : 'sent:', ack.rfq_id)
