/**
 * Public market data — no login needed.
 *
 *   pnpm example examples/market-data.ts
 *
 * Uses the curl transport: Node's own HTTP client is fingerprinted and refused by
 * Cloudflare on every request (docs/ACCESS.md). Works from a home connection; from a
 * datacenter IP you need the browser transport instead.
 */
import { curlTransport, OmniClient } from '../dist/index.js'

const client = new OmniClient({ fetchImpl: curlTransport })

const config = await client.getConfig()
console.log('min order notional:', config.min_order_notional)

for (const symbol of ['BTC', 'ETH', 'SOL']) {
  const f = await client.getFunding({ symbol, instrument_type: 'perpetual_future' })
  const hours = f.funding_interval_s / 3600
  // A PREDICTION for the next payment, per interval — not settled history (docs/API.md).
  console.log(
    `${symbol.padEnd(4)} predicted funding ${f.predicted_funding_rate} per ${hours}h, next at ${f.next_funding_time}`,
  )
}
