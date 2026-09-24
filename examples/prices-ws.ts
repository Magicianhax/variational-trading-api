/**
 * Live mark prices over WebSocket — no login needed.
 *
 *   pnpm example examples/prices-ws.ts
 *
 * `/prices` multiplexes many instruments at ~1 Hz but rounds to display precision; for
 * an unrounded mark, poll REST `client.quoteSimple()` (`mark_price`), which needs no
 * session either (docs/API.md).
 */
import { DEFAULT_WS_URL, PricesFeed } from '../dist/index.js'

const feed = new PricesFeed({ wsBaseUrl: DEFAULT_WS_URL })
feed.on('mark', (t) => console.log(new Date(t.ts).toISOString(), t.key, t.price))
feed.on('unsupported', (e) => console.error('venue rejected', e.key, e.message))
feed.subscribe([
  { symbol: 'BTC', instrument_type: 'perpetual_future' },
  { symbol: 'ETH', instrument_type: 'perpetual_future' },
])
feed.start()
setTimeout(() => {
  feed.stop()
  process.exit(0)
}, 15_000)
