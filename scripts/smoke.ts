/**
 * Live smoke test — NOT part of the CI suite.
 *
 * Hits only PUBLIC, UNAUTHENTICATED, NON-MUTATING endpoints, with the client in
 * dry-run so a mutating call is structurally impossible even by accident.
 *
 * Run:  npm run smoke
 *       npm run smoke -- --no-ws
 *
 * Transport note (resolved 2026-08-13): `https://omni.variational.io/api` is behind a
 * Cloudflare challenge that gates on BOTH the TLS fingerprint and the header order.
 * Node's own HTTP client cannot pass it at all, so the client defaults to a curl-backed
 * transport (`src/curl-transport.ts`). With that in place every check below passes.
 * A CHALLENGED result now means the transport has regressed or Cloudflare tightened —
 * treat it as a real failure, not an expected condition.
 */

import {
  DEFAULT_WS_URL,
  isApiError,
  isSchemaDriftError,
  OmniClient,
  PricesFeed,
  type PricesFeedEvents,
  QuotesFeed,
  type QuotesFeedEvents,
} from '../dist/index.js'

type Outcome = 'PASS' | 'FAIL' | 'CHALLENGED' | 'SKIP'

const results: Array<{ name: string; outcome: Outcome; detail: string }> = []

function record(name: string, outcome: Outcome, detail: string): void {
  results.push({ name, outcome, detail })
  const colour = outcome === 'PASS' ? '[32m' : outcome === 'FAIL' ? '[31m' : '[33m'
  console.log(`${colour}${outcome.padEnd(11)}[0m ${name.padEnd(34)} ${detail}`)
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, 'PASS', await fn())
  } catch (err) {
    if (isApiError(err) && err.status === 403 && err.headers['cf-mitigated'] === 'challenge') {
      record(
        name,
        'CHALLENGED',
        'Cloudflare managed challenge — needs a browser-grade TLS fingerprint',
      )
      return
    }
    if (isSchemaDriftError(err)) {
      record(name, 'FAIL', `SCHEMA DRIFT: ${err.message}`)
      return
    }
    record(name, 'FAIL', err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  }
}

const BTC = { symbol: 'BTC', instrument_type: 'perpetual_future' as const }

async function main(): Promise<void> {
  const withWs = !process.argv.includes('--no-ws')
  // dryRun: true — belt and braces. Nothing here is mutating anyway.
  const client = new OmniClient({ dryRun: true })

  console.log('\nvariational-trading-api — public endpoint smoke test\n')

  await check('GET /metadata/config', async () => {
    const config = await client.getConfig()
    return `min_order_notional=${config.min_order_notional}`
  })

  await check('GET /metadata/supported_assets', async () => {
    const index = await client.getAssetIndex()
    const btc = index.get('BTC')
    return `${index.size} assets; BTC=${btc?.name ?? '?'} type=${btc?.instrument_type ?? '?'}`
  })

  await check('GET /metadata/v2/risk_limits', async () => {
    const limits = await client.getRiskLimits(BTC)
    return `mark=${limits.mark_price} oi=${limits.current_oi_usd}/${limits.oi_limit_usd}`
  })

  await check('GET /metadata/v2/open_interest', async () => {
    const oi = await client.getOpenInterest(BTC)
    return `long=${oi.long_qty} short=${oi.short_qty}`
  })

  await check('GET /funding/v2', async () => {
    const funding = await client.getFunding(BTC)
    return `rate=${funding.predicted_funding_rate} interval=${funding.funding_interval_s}s`
  })

  await check('GET /metadata/tiers', async () => `${(await client.getTiers()).length} tiers`)

  await check('GET /ff', async () => (await client.getFeatureFlags()).join(','))

  await check('GET /metadata/stats (public host)', async () => {
    const stats = await client.getStats(true)
    return `markets=${stats.num_markets ?? '?'} tvl=${stats.tvl ?? '?'}`
  })

  await check('POST /quotes/simple', async () => {
    const quote = await client.quoteSimple({ instrument: BTC, qty: '0.001' })
    return `mark=${quote.mark_price ?? '?'} bid=${quote.bid} ask=${quote.ask} tick=${quote.qty_limits?.bid.min_qty_tick ?? '?'}`
  })

  await check('GET /me (expect token:"")', async () => {
    const me = await client.getMe()
    return me.token === ''
      ? 'unauthenticated, as expected'
      : `AUTHENTICATED (token length ${me.token.length})`
  })

  if (!withWs) {
    record('ws /prices', 'SKIP', '--no-ws')
    record('ws /quotes/simple', 'SKIP', '--no-ws')
  } else {
    await check('ws /prices', async () => {
      const feed = new PricesFeed({ wsBaseUrl: DEFAULT_WS_URL })
      try {
        const tick = await firstEvent<PricesFeedEvents, 'mark'>(feed, 'mark', 15_000)
        return `${tick.key} price=${tick.price}`
      } finally {
        feed.stop()
      }
    })

    await check('ws /quotes/simple', async () => {
      const feed = new QuotesFeed({ wsBaseUrl: DEFAULT_WS_URL, instrument: BTC, qty: '0.001' })
      try {
        const { quote } = await firstEvent<QuotesFeedEvents, 'quote'>(feed, 'quote', 15_000)
        return `mark=${quote.mark_price ?? '?'} index=${quote.index_price ?? '?'}`
      } finally {
        feed.stop()
      }
    })
  }

  const failed = results.filter((r) => r.outcome === 'FAIL')
  const challenged = results.filter((r) => r.outcome === 'CHALLENGED')
  console.log(
    `\n${results.filter((r) => r.outcome === 'PASS').length} passed, ${failed.length} failed, ${challenged.length} challenged, ${results.filter((r) => r.outcome === 'SKIP').length} skipped\n`,
  )
  if (challenged.length > 0) {
    console.log(
      'CHALLENGED is a REGRESSION: the curl transport passes all of these as of 2026-08-13.',
    )
    console.log(
      'Check packages/omni-client/src/curl-transport.ts (UA must go via --user-agent, never',
    )
    console.log('--header) and its regression tests, or Cloudflare has tightened further.\n')
  }
  // A challenge is now a failure, not an expected condition.
  process.exitCode = failed.length === 0 && challenged.length === 0 ? 0 : 1
}

/** Await the first emission of `event`, or reject on timeout. */
function firstEvent<E extends Record<string, unknown>, K extends keyof E>(
  feed: { on: (event: K, listener: (payload: E[K]) => void) => () => void; start: () => void },
  event: K,
  timeoutMs: number,
): Promise<E[K]> {
  return new Promise<E[K]>((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`no "${String(event)}" frame within ${timeoutMs}ms`))
    }, timeoutMs)
    const off = feed.on(event, (payload) => {
      clearTimeout(timer)
      off()
      resolve(payload)
    })
    feed.start()
  })
}

await main()
