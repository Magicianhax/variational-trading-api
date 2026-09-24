/**
 * Quote, then a market order — DRY RUN unless DRY_RUN=false.
 *
 *   pnpm example examples/trade.ts [path/to/session.json]
 *
 * Needs a session, found as examples/account.ts finds it (docs/AUTH.md).
 *
 * A market order needs a fresh quote id; quotes age out fast (QUOTE_MAX_AGE_MS), so
 * quote and order back to back. Slippage is passed in bps here and sent to the venue as
 * a FRACTION of 1 — the client does that conversion (docs/API.md).
 */
import { clientFromEnv, exitWith, isDryRun, loadEnv } from './_env.ts'

loadEnv()
const dryRun = isDryRun()
const client = clientFromEnv({ dryRun })
const me = await client.getMe()
if (me.token === '') exitWith('The venue did not accept the session (signed out or expired).')

const instrument = { symbol: 'BTC', instrument_type: 'perpetual_future' as const }
const quote = await client.quoteIndicative({ instrument, qty: '0.0001' })
console.log('quote', quote.quote_id, 'bid', quote.bid, 'ask', quote.ask)

const ack = await client.placeMarketOrder({
  quoteId: quote.quote_id,
  side: 'Buy',
  maxSlippageBps: 20,
})
console.log(dryRun ? 'DRY RUN — nothing was sent:' : 'sent:', ack.rfq_id)
