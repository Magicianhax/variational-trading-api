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
  // A PREDICTION, not settled history. The value is an ANNUALISED rate as a decimal —
  // checked against the web app's "8hr Funding" figure (docs/API.md#funding).
  const annual = Number(f.predicted_funding_rate)
  const perPeriod = annual / ((365 * 24 * 3600) / f.funding_interval_s)
  console.log(
    `${symbol.padEnd(4)} predicted funding ${(annual * 100).toFixed(2)}% a year = ${(perPeriod * 100).toFixed(4)}% per ${hours}h, next at ${f.next_funding_time}`,
  )
}
