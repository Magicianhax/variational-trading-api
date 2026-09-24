import { describe, expect, it } from 'vitest'
import { OmniClient } from '../src/client.js'
import { InvalidRequestError } from '../src/errors.js'
import { instrumentKey } from '../src/instrument.js'
import { orderSchema } from '../src/schemas.js'
import { mintSessionViaSiwe } from '../src/session.js'
import { FakeClock, FakeFetch, fixture } from './helpers.js'

function client(fetch: FakeFetch, options: { dryRun?: boolean } = {}) {
  const clock = new FakeClock()
  return {
    clock,
    client: new OmniClient({
      fetchImpl: fetch.fetch,
      dryRun: options.dryRun ?? false,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      idFactory: () => 'fixed-id',
      connectedAddress: '0xdead',
    }),
  }
}

const BTC = { symbol: 'BTC', instrument_type: 'perpetual_future' as const }

/** The web3.js documentation test-vector key: public, holds nothing. */
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'

describe('reads', () => {
  it('parses /positions and keeps the signed qty as the venue sent it', async () => {
    const fetch = new FakeFetch().push({ body: fixture('positions.json') })
    const { client: c } = client(fetch)
    const positions = await c.getPositions()
    expect(positions).toHaveLength(2)
    expect(positions[0]?.position_info.qty).toBe('0.500000')
    expect(positions[1]?.position_info.qty).toBe('-4.000000')
    expect(fetch.last()?.url).toBe('https://omni.variational.io/api/positions')
  })

  it('filters positions by the KEY-STRING instrument form', async () => {
    const fetch = new FakeFetch().push({ body: [] })
    const { client: c } = client(fetch)
    await c.getPositions({ instrument: [instrumentKey(BTC)] })
    expect(fetch.last()?.url).toContain('instrument=P-BTC-USDC-3600')
  })

  it('always asks /portfolio for computed margin', async () => {
    const fetch = new FakeFetch().push({ body: fixture('portfolio.json') })
    const { client: c } = client(fetch)
    const portfolio = await c.getPortfolio()
    expect(fetch.last()?.url).toContain('compute_margin=true')
    expect(portfolio.sub_accounts?.cross_available).toBe('5821.92')
  })

  it('derives margin mode from sub_accounts.isolated, the only place it exists', async () => {
    const fetch = new FakeFetch().push({ body: fixture('portfolio.json') })
    const { client: c } = client(fetch)
    const portfolio = await c.getPortfolio()
    expect(OmniClient.marginModeOf(portfolio, BTC)).toBe('cross')
    expect(OmniClient.marginModeOf(portfolio, { symbol: 'ETH' })).toBe('isolated')
    expect(OmniClient.isolatedSubAccountFor(portfolio, { symbol: 'ETH' })?.balance).toBe('1000.00')
  })

  it('normalises both paginated shapes of /orders/v2', async () => {
    const paged = fixture<{ result: unknown[] }>('orders-v2-pending.json')
    const fetch = new FakeFetch().push({ body: paged }, { body: paged.result })
    const { client: c } = client(fetch)

    const withEnvelope = await c.getOrders({ status: 'pending' })
    expect(withEnvelope.rows).toHaveLength(1)
    expect(withEnvelope.objectCount).toBe(1)

    const bare = await c.getOrders({ status: 'pending' })
    expect(bare.rows).toHaveLength(1)
    expect(bare.objectCount).toBeUndefined()
  })

  it('parses the recorded metadata endpoints', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('metadata-config.json') })
      .push({ body: fixture('risk-limits-btc.json') })
      .push({ body: fixture('funding-btc.json') })
      .push({ body: fixture('supported-assets.json') })
      .push({ body: fixture('ff.json') })
      .push({ body: fixture('metadata-tiers.json') })
      .push({ body: fixture('open-interest-btc.json') })
    const { client: c } = client(fetch)

    expect((await c.getConfig()).min_order_notional).toBe('0.1')

    const risk = await c.getRiskLimits(BTC)
    // Numbers here, decimal strings almost everywhere else.
    expect(typeof risk.mark_price).toBe('number')
    expect(typeof risk.long_qty).toBe('string')
    expect(fetch.last()?.url).toContain('underlying=BTC&instrument_type=perpetual_future')

    const funding = await c.getFunding(BTC)
    expect(funding.funding_interval_s).toBe(28800)

    expect((await c.getAssetIndex()).get('BTC')?.name).toBe('Bitcoin')
    expect(await c.getFeatureFlags()).toEqual(['WL', 'PS', 'OR'])
    expect((await c.getTiers())[0]?.name).toBe('Iron')
    expect((await c.getOpenInterest(BTC)).long_qty).toBe('1593.834206800000')
  })

  it('passes asset_class for an RWA risk-limits query', async () => {
    const fetch = new FakeFetch().push({ body: fixture('risk-limits-shaz-rwa.json') })
    const { client: c } = client(fetch)
    await c.getRiskLimits({
      symbol: 'SHAZ',
      instrument_type: 'perpetual_rwa_future',
      asset_class: 'equity',
    })
    expect(fetch.last()?.url).toContain('asset_class=equity')
  })
})

describe('the stop-loss order builder — the safety-critical payload', () => {
  it('emits exactly the shape the spec pins down', async () => {
    const fetch = new FakeFetch().push({ body: { rfq_id: 'rfq-1' } })
    const { client: c } = client(fetch)

    const ack = await c.placeStopLoss({
      instrument: BTC,
      qty: '0.0010009',
      side: 'Sell',
      triggerPrice: 61234.5,
      maxSlippageBps: 300,
      minQtyTick: '0.000001',
    })

    expect(ack.rfq_id).toBe('rfq-1')
    expect(fetch.last()?.url).toBe('https://omni.variational.io/api/orders/new/limit')
    expect(fetch.last()?.body).toEqual({
      order_type: 'stop_loss',
      instrument: {
        underlying: 'BTC',
        instrument_type: 'perpetual_future',
        settlement_asset: 'USDC',
        funding_interval_s: 3600,
      },
      qty: '0.001',
      side: 'sell',
      trigger_price: '61234.5',
      slippage_limit: '0.03',
      is_reduce_only: true,
      is_auto_resize: true,
      use_mark_price: true,
    })
  })

  it('sets is_reduce_only explicitly rather than inheriting the reference client fragility', () => {
    const { client: c } = client(new FakeFetch())
    const payload = c.buildStopLossPayload({
      instrument: BTC,
      qty: 1,
      side: 'Buy',
      triggerPrice: 100,
      maxSlippageBps: 50,
    })
    expect(payload.is_reduce_only).toBe(true)
    expect(payload.order_type).toBe('stop_loss')
    expect(payload.side).toBe('buy')
    expect(payload.slippage_limit).toBe('0.005')
  })

  it('never sends the literal order_type "trigger" — a trigger is limit + use_mark_price', async () => {
    const fetch = new FakeFetch().push({ body: { rfq_id: 'rfq-2' } })
    const { client: c } = client(fetch)
    await c.placeLimitOrder({
      instrument: BTC,
      qty: '1',
      side: 'Buy',
      limitPrice: 60000,
      maxSlippageBps: 50,
      useMarkPrice: true,
      minQtyTick: '0.001',
    })
    const body = fetch.last()?.body as { order_type: string; use_mark_price: boolean }
    expect(body.order_type).toBe('limit')
    expect(body.use_mark_price).toBe(true)
  })

  it('refuses to attach brackets to a reduce-only order', async () => {
    const { client: c } = client(new FakeFetch())
    await expect(
      c.placeLimitOrder({
        instrument: BTC,
        qty: '1',
        side: 'Sell',
        limitPrice: 1,
        maxSlippageBps: 50,
        isReduceOnly: true,
        brackets: { stop_loss: '1' },
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError)
  })

  it('rounds qty with the cached min_qty_tick learned from a quote', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: { rfq_id: 'rfq-3' } })
    const { client: c } = client(fetch)

    await c.quoteSimple({ instrument: BTC, qty: '0.001' })
    expect(c.getCachedQtyTick(BTC, 'Sell')).toBe('0.000001')

    await c.placeStopLoss({
      instrument: BTC,
      qty: '0.12345678',
      side: 'Sell',
      triggerPrice: 60000,
      maxSlippageBps: 300,
    })
    const sent = fetch.last()?.body as { qty: string }
    expect(sent.qty).toBe('0.123456')
  })
})

describe('quotes and closes', () => {
  it('POSTs exactly {instrument, qty} and nothing else', async () => {
    const fetch = new FakeFetch().push({ body: fixture('quote-simple-btc.json') })
    const { client: c } = client(fetch)
    const quote = await c.quoteSimple({ instrument: BTC, qty: 0.001 })
    expect(fetch.last()?.body).toEqual({
      instrument: {
        underlying: 'BTC',
        instrument_type: 'perpetual_future',
        settlement_asset: 'USDC',
        funding_interval_s: 3600,
      },
      qty: '0.001',
    })
    expect(quote.mark_price).toBe('63346.7543455801')
  })

  it('quotes then accepts, with max_slippage as a JSON NUMBER fraction', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: { rfq_id: 'rfq-close' } })
    const { client: c } = client(fetch)

    const { ack, requoted } = await c.closeAtMarket({
      instrument: BTC,
      qty: '0.001',
      side: 'Sell',
      maxSlippageBps: 100,
      indicative: false,
    })

    expect(ack.rfq_id).toBe('rfq-close')
    expect(requoted).toBe(false)
    expect(fetch.calls[0]?.url).toContain('/quotes/simple')
    expect(fetch.calls[1]?.url).toContain('/quotes/accept')
    expect(fetch.calls[1]?.body).toEqual({
      quote_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      side: 'sell',
      max_slippage: 0.01,
      is_reduce_only: true,
    })
  })

  it('re-quotes rather than accepting a quote older than the freshness budget', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: { rfq_id: 'rfq-fresh' } })
    const clock = new FakeClock()
    const c = new OmniClient({
      fetchImpl: fetch.fetch,
      dryRun: false,
      // Burn 1 s of wall clock between minting and accepting.
      now: () => {
        clock.advance(1_000)
        return clock.now()
      },
      sleep: clock.sleep,
    })
    const { requoted } = await c.closeAtMarket({
      instrument: BTC,
      qty: '0.001',
      side: 'Sell',
      maxSlippageBps: 100,
      indicative: false,
    })
    expect(requoted).toBe(true)
    expect(fetch.count).toBe(3)
  })

  it('learns the qty tick from a quote before its first stop, never sending a raw float', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: { rfq_id: 'rfq-1' } })
    const { client: c } = client(fetch)
    // What float arithmetic produces after a partial fill: 0.1 + 0.2.
    await c.placeStopLoss({
      instrument: BTC,
      qty: 0.1 + 0.2,
      side: 'Sell',
      triggerPrice: 61234.5,
      maxSlippageBps: 300,
    })
    expect(fetch.count).toBe(2)
    expect((fetch.last()?.body as { qty: string } | undefined)?.qty).toBe('0.3')
  })

  it('truncates a close qty with float drift to the quoted tick, re-quoting once', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: { rfq_id: 'rfq-close' } })
    const { client: c } = client(fetch)
    const { requoted } = await c.closeAtMarket({
      instrument: BTC,
      qty: 0.1 + 0.2,
      side: 'Sell',
      maxSlippageBps: 100,
      indicative: false,
    })
    expect(requoted).toBe(true)
    expect(fetch.count).toBe(3)
    expect((fetch.calls[1]?.body as { qty: string } | undefined)?.qty).toBe('0.3')
  })

  it('counts the quote round trip as age, so a slow quote is re-minted before accept', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: { rfq_id: 'rfq-fresh' } })
    const clock = new FakeClock()
    const c = new OmniClient({
      // Every venue call takes 5 s of wall clock; the clock itself is otherwise still.
      fetchImpl: async (url, init) => {
        clock.advance(5_000)
        return fetch.fetch(url, init)
      },
      dryRun: false,
      now: () => clock.now(),
      sleep: clock.sleep,
    })
    const { requoted } = await c.closeAtMarket({
      instrument: BTC,
      qty: '0.001',
      side: 'Sell',
      maxSlippageBps: 100,
      indicative: false,
    })
    expect(requoted).toBe(true)
    expect(fetch.count).toBe(3)
  })

  it('rejects a close whose qty violates the quote qty_limits before sending it', async () => {
    const fetch = new FakeFetch().push({ body: fixture('quote-simple-btc.json') })
    const { client: c } = client(fetch)
    await expect(
      c.closeAtMarket({
        instrument: BTC,
        qty: '0.0000001',
        side: 'Sell',
        maxSlippageBps: 100,
        indicative: false,
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError)
    expect(fetch.count).toBe(1)
  })

  it('routes through /orders/new/market when asked', async () => {
    const fetch = new FakeFetch()
      .push({ body: fixture('quote-simple-btc.json') })
      .push({ body: { rfq_id: 'rfq-mkt' } })
    const { client: c } = client(fetch)
    await c.closeAtMarket({
      instrument: BTC,
      qty: '0.001',
      side: 'Buy',
      maxSlippageBps: 50,
      indicative: false,
      viaOrdersEndpoint: true,
    })
    expect(fetch.calls[1]?.url).toContain('/orders/new/market')
    // No instrument and no qty: both are baked into the quote.
    expect(fetch.calls[1]?.body).toEqual({
      quote_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      side: 'buy',
      max_slippage: 0.005,
      is_reduce_only: true,
    })
  })
})

describe('other order routes', () => {
  it('cancels by rfq_id', async () => {
    const fetch = new FakeFetch().push({ body: {} })
    const { client: c } = client(fetch)
    await c.cancelOrder('rfq-9')
    expect(fetch.last()?.url).toContain('/orders/cancel')
    expect(fetch.last()?.body).toEqual({ rfq_id: 'rfq-9' })
  })

  it('sends close_all slippage as a FRACTION despite the field name', async () => {
    const fetch = new FakeFetch().push({ body: {} })
    const { client: c } = client(fetch)
    await c.closeAll(100)
    expect(fetch.last()?.body).toEqual({ slippage_percent: '0.01' })
  })

  it('lists TP/SL with the closing side and the OBJECT instrument form', async () => {
    const orders = fixture<{ result: unknown[] }>('orders-v2-pending.json').result
    const fetch = new FakeFetch().push({ body: orders })
    const { client: c } = client(fetch)
    const rows = await c.getTpslOrders(BTC, 'Sell')
    expect(rows).toHaveLength(1)
    const body = fetch.last()?.body as { side: string; instrument: unknown }
    expect(body.side).toBe('sell')
    expect(body.instrument).toEqual({
      underlying: 'BTC',
      instrument_type: 'perpetual_future',
      settlement_asset: 'USDC',
      funding_interval_s: 3600,
    })
  })

  it('refuses to replace an order whose qty the venue did not report', async () => {
    /*
     * `qty` is nullable on /orders/v2 — observed live. Replacing an order means
     * re-placing it from its own fields, which cannot be done when the size is
     * unknown. Coercing a null to 0 or '' would submit a nonsense order; refusing
     * names the problem instead.
     */
    const rows = fixture<{ result: unknown[] }>('orders-v2-pending.json').result
    const parsed = orderSchema.parse({ ...(rows[0] as object), qty: null })
    const fetch = new FakeFetch().push({ body: {} }, { body: { rfq_id: 'never' } })
    const { client: c } = client(fetch)

    await expect(c.replaceOrder(parsed, { trigger_price: '61999.9' })).rejects.toThrow(/qty/i)
    // Nothing may be cancelled either: a failed replace must not leave the venue bare.
    expect(fetch.calls).toHaveLength(0)
  })

  it('replaces an order as cancel + resubmit, preserving every flag', async () => {
    const rows = fixture<{ result: unknown[] }>('orders-v2-pending.json').result
    const parsed = orderSchema.parse(rows[0])
    const fetch = new FakeFetch().push({ body: {} }, { body: { rfq_id: 'rfq-new' } })
    const { client: c } = client(fetch)

    const ack = await c.replaceOrder(parsed, { trigger_price: '61999.9' })
    expect(ack.rfq_id).toBe('rfq-new')
    expect(fetch.calls[0]?.url).toContain('/orders/cancel')
    const resubmit = fetch.calls[1]?.body as {
      order_type: string
      trigger_price: string
      is_reduce_only: boolean
      is_auto_resize: boolean
      use_mark_price: boolean
    }
    expect(resubmit.order_type).toBe('stop_loss')
    expect(resubmit.trigger_price).toBe('61999.9')
    expect(resubmit.is_reduce_only).toBe(true)
    expect(resubmit.is_auto_resize).toBe(true)
    expect(resubmit.use_mark_price).toBe(true)
  })
})

describe('session handling', () => {
  it('captures the JWT from /me and decodes its claims', async () => {
    const claims = { exp: 4_102_444_800, address: '0xfeed', scope: 'transfer:none' }
    const jwt = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
    const fetch = new FakeFetch().push({ body: { token: jwt } })
    const { client: c } = client(fetch)

    await c.getMe()
    expect(c.getToken()).toBe(jwt)
    expect(c.decodeToken()?.address).toBe('0xfeed')
    expect(c.decodeToken()?.scope).toBe('transfer:none')
    expect(c.isTokenExpiring()).toBe(false)
  })

  it('reports an expiring token', async () => {
    const clock = new FakeClock()
    const c = new OmniClient({ fetchImpl: new FakeFetch().fetch, now: clock.now })
    const claims = { exp: Math.floor(clock.now() / 1000) + 10 }
    c.setToken(`h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`)
    expect(c.isTokenExpiring(30)).toBe(true)
    expect(c.isTokenExpiring(5)).toBe(false)
  })

  it('treats an empty token as unauthenticated', async () => {
    const fetch = new FakeFetch().push({ body: { token: '' } })
    const { client: c } = client(fetch)
    expect(await c.isAuthenticated()).toBe(false)
    expect(c.getToken()).toBeUndefined()
  })

  it('strips the 0x prefix from a signature before login', async () => {
    const fetch = new FakeFetch().push({ body: { token: 'jwt' } })
    const { client: c } = client(fetch)
    await c.login({ address: '0xabc', signedMessage: '0xdeadbeef' })
    const loginBody = fetch.last()?.body as { signed_message: string }
    expect(loginBody.signed_message).toBe('deadbeef')
    // No captcha for an existing account: the key must be absent entirely.
    expect(Object.keys(fetch.last()?.body as object)).not.toContain('captchaToken')
  })
})

describe('dry run at the client level', () => {
  it('suppresses every mutating call and still returns a usable ack', async () => {
    const fetch = new FakeFetch().push({ body: fixture('quote-simple-btc.json') })
    const { client: c } = client(fetch, { dryRun: true })

    const sl = await c.placeStopLoss({
      instrument: BTC,
      qty: '0.001',
      side: 'Sell',
      triggerPrice: 60000,
      maxSlippageBps: 300,
    })
    expect(sl.rfq_id).toBe('dry-run-limit-fixed-id')

    const close = await c.closeAtMarket({
      instrument: BTC,
      qty: '0.001',
      side: 'Sell',
      maxSlippageBps: 100,
      indicative: false,
    })
    expect(close.ack.rfq_id).toBe('dry-run-accept-fixed-id')

    await c.cancelOrder('whatever')
    await c.closeAll(100)

    // Only the quote mint hit the network — it trades nothing.
    expect(fetch.count).toBe(1)
    expect(fetch.calls[0]?.url).toContain('/quotes/simple')
  })

  it('can be flipped at runtime', () => {
    const { client: c } = client(new FakeFetch(), { dryRun: true })
    expect(c.dryRun).toBe(true)
    c.setDryRun(false)
    expect(c.dryRun).toBe(false)
  })

  it('defaults to dry-run when the option is omitted', () => {
    expect(new OmniClient().dryRun).toBe(true)
  })

  it('does not gate login, which moves no money, so SIWE works on a default client', async () => {
    const signingData = { body: 'omni.variational.io wants you to sign in' }
    const login = { body: { token: 'jwt.from.venue' }, headers: { 'set-cookie': 'vr-token=a' } }
    const fetch = new FakeFetch().push(signingData, login)
    const { client: c } = client(fetch, { dryRun: true })
    const bundle = await mintSessionViaSiwe(c, KEY)
    expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/auth/generate_signing_data',
      '/api/auth/login',
    ])
    expect(bundle.token).toBe('jwt.from.venue')
  })

  it('still gates logout, which destroys a session', async () => {
    const fetch = new FakeFetch()
    const { client: c } = client(fetch, { dryRun: true })
    await c.logout('0xabc')
    expect(fetch.count).toBe(0)
  })
})
