import { beforeEach, describe, expect, it } from 'vitest'
import { SchemaDriftError } from '../src/errors.js'
import { PricesFeed } from '../src/ws/prices.js'
import { EventsFeed, PortfolioFeed } from '../src/ws/private.js'
import { QuotesFeed, QuotesFeedPool } from '../src/ws/quotes.js'
import { ManagedSocket } from '../src/ws/socket.js'
import { FakeClock, FakeSocket, fakeFactory, fixture } from './helpers.js'

const WS = 'wss://omni-ws-server.prod.ap-northeast-1.variational.io'

beforeEach(() => {
  FakeSocket.reset()
})

function timers(clock: FakeClock) {
  return { setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout }
}

describe('ManagedSocket', () => {
  it('reconnects immediately on the first failure, then backs off exponentially, capped', () => {
    const clock = new FakeClock()
    const delays: number[] = []
    const socket = new ManagedSocket({
      url: `${WS}/prices`,
      name: 'test',
      factory: fakeFactory,
      silenceMs: 0,
      ...timers(clock),
    })
    socket.on('reconnect', (r) => delays.push(r.delayMs))

    socket.start()
    for (let i = 0; i < 8; i++) {
      FakeSocket.last.serverClose()
      clock.advance(120_000)
    }
    expect(delays.slice(0, 5)).toEqual([0, 1_000, 2_000, 4_000, 8_000])
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(60_000)
  })

  it('resets the backoff after a successful open', () => {
    const clock = new FakeClock()
    const delays: number[] = []
    const socket = new ManagedSocket({
      url: WS,
      name: 't',
      factory: fakeFactory,
      silenceMs: 0,
      ...timers(clock),
    })
    socket.on('reconnect', (r) => delays.push(r.delayMs))

    socket.start()
    FakeSocket.last.serverClose()
    clock.advance(10)
    FakeSocket.last.serverClose()
    clock.advance(2_000)
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverClose()
    clock.advance(10)

    expect(delays).toEqual([0, 1_000, 0])
  })

  it('abandons a handshake that stalls past the connect timeout', () => {
    const clock = new FakeClock()
    const socket = new ManagedSocket({
      url: WS,
      name: 't',
      factory: fakeFactory,
      connectTimeoutMs: 4_000,
      silenceMs: 0,
      ...timers(clock),
    })
    socket.start()
    expect(FakeSocket.instances).toHaveLength(1)
    clock.advance(4_001)
    // A reconnect was scheduled with a 0 ms first delay and fired.
    expect(FakeSocket.instances.length).toBeGreaterThan(1)
  })

  it('forces a reconnect after the inbound-silence watchdog expires', () => {
    const clock = new FakeClock()
    const socket = new ManagedSocket({
      url: WS,
      name: 't',
      factory: fakeFactory,
      silenceMs: 12_000,
      ...timers(clock),
    })
    socket.start()
    FakeSocket.last.serverOpen()

    clock.advance(11_000)
    FakeSocket.last.serverSend({ type: 'heartbeat', timestamp: 'now' })
    clock.advance(11_000)
    expect(FakeSocket.instances).toHaveLength(1)

    clock.advance(2_000)
    expect(FakeSocket.instances.length).toBeGreaterThan(1)
  })

  it('filters heartbeats out of the message stream', () => {
    const clock = new FakeClock()
    const socket = new ManagedSocket({
      url: WS,
      name: 't',
      factory: fakeFactory,
      silenceMs: 0,
      ...timers(clock),
    })
    const messages: unknown[] = []
    const beats: string[] = []
    socket.on('message', (m) => messages.push(m))
    socket.on('heartbeat', (h) => beats.push(h.timestamp))
    socket.start()
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverSend({ type: 'heartbeat', timestamp: '2026-08-13T15:56:15.685454742Z' })
    FakeSocket.last.serverSend({ hello: true })
    expect(beats).toEqual(['2026-08-13T15:56:15.685454742Z'])
    expect(messages).toEqual([{ hello: true }])
  })

  it('surfaces non-JSON frames instead of swallowing them like the reference client', () => {
    const clock = new FakeClock()
    const socket = new ManagedSocket({
      url: WS,
      name: 't',
      factory: fakeFactory,
      silenceMs: 0,
      ...timers(clock),
    })
    const texts: string[] = []
    socket.on('text', (t) => texts.push(t))
    socket.start()
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverSend('Token timeout: Unauthorized')
    expect(texts).toEqual(['Token timeout: Unauthorized'])
  })

  it('queues sends until OPEN and drops the queue on close', () => {
    const clock = new FakeClock()
    const socket = new ManagedSocket({
      url: WS,
      name: 't',
      factory: fakeFactory,
      silenceMs: 0,
      ...timers(clock),
    })
    socket.start()
    socket.send({ a: 1 })
    expect(FakeSocket.last.sent).toHaveLength(0)

    FakeSocket.last.serverOpen()
    expect(FakeSocket.last.sentJson).toEqual([{ a: 1 }])

    socket.send({ b: 2 })
    const first = FakeSocket.last
    first.serverClose()
    clock.advance(1)
    // Fresh socket, empty queue: nothing is replayed late.
    expect(FakeSocket.last).not.toBe(first)
    FakeSocket.last.serverOpen()
    expect(FakeSocket.last.sent).toHaveLength(0)
  })

  it('stops for good when told to', () => {
    const clock = new FakeClock()
    const socket = new ManagedSocket({
      url: WS,
      name: 't',
      factory: fakeFactory,
      silenceMs: 0,
      ...timers(clock),
    })
    socket.start()
    FakeSocket.last.serverOpen()
    socket.stop()
    expect(socket.state).toBe('closed')
    clock.advance(120_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('PricesFeed', () => {
  function feed(
    clock: FakeClock,
    options: Partial<ConstructorParameters<typeof PricesFeed>[0]> = {},
  ) {
    return new PricesFeed({ wsBaseUrl: WS, factory: fakeFactory, ...timers(clock), ...options })
  }

  it('connects to /prices and subscribes with funding_interval_s pinned to 3600', () => {
    const clock = new FakeClock()
    const f = feed(clock)
    f.subscribe([{ symbol: 'ETH' }])
    f.start()
    FakeSocket.last.serverOpen()

    expect(FakeSocket.last.url).toBe(`${WS}/prices`)
    expect(FakeSocket.last.sentJson[0]).toEqual({
      action: 'subscribe',
      instruments: [
        {
          underlying: 'BTC',
          instrument_type: 'perpetual_future',
          settlement_asset: 'USDC',
          funding_interval_s: 3600,
        },
        {
          underlying: 'ETH',
          instrument_type: 'perpetual_future',
          settlement_asset: 'USDC',
          funding_interval_s: 3600,
        },
      ],
    })
  })

  it('re-subscribes everything on every reconnect (the send queue does not survive)', () => {
    const clock = new FakeClock()
    const f = feed(clock)
    f.subscribe([{ symbol: 'ETH' }])
    f.start()
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverClose()
    clock.advance(1)
    FakeSocket.last.serverOpen()

    const frame = FakeSocket.last.sentJson[0] as { action: string; instruments: unknown[] }
    expect(frame.action).toBe('subscribe')
    expect(frame.instruments).toHaveLength(2)
  })

  it('never lets the subscription set empty — the sentinel is unremovable', () => {
    const clock = new FakeClock()
    const f = feed(clock)
    f.subscribe([{ symbol: 'ETH' }])
    f.start()
    FakeSocket.last.serverOpen()

    f.unsubscribe([{ symbol: 'ETH' }, { symbol: 'BTC' }])
    expect(f.subscriptions()).toEqual(['P-BTC-USDC-3600'])

    const unsub = FakeSocket.last.sentJson[1] as {
      action: string
      instruments: Array<{ underlying: string }>
    }
    expect(unsub.action).toBe('unsubscribe')
    expect(unsub.instruments.map((i) => i.underlying)).toEqual(['ETH'])
  })

  it('refuses an unsupported key up front when a validator is wired in', () => {
    const clock = new FakeClock()
    const f = feed(clock, { isSupported: (key) => key !== 'P-NOPE-USDC-3600' })
    f.start()
    FakeSocket.last.serverOpen()
    f.subscribe([{ symbol: 'NOPE' }])
    expect(f.subscriptions()).toEqual(['P-BTC-USDC-3600'])
  })

  it('drops an instrument the venue rejects so the reconnect does not re-kill the socket', () => {
    const clock = new FakeClock()
    const f = feed(clock)
    const rejected: string[] = []
    f.on('unsupported', (u) => rejected.push(u.key))
    f.subscribe([{ symbol: 'BADCOIN' }])
    f.start()
    FakeSocket.last.serverOpen()

    FakeSocket.last.serverSend('unsupported instrument: P-BADCOIN-USDC-3600')
    expect(rejected).toEqual(['P-BADCOIN-USDC-3600'])
    expect(f.subscriptions()).toEqual(['P-BTC-USDC-3600'])
  })

  it('emits a normalised MarkTick and de-duplicates repeated pricing timestamps', () => {
    const clock = new FakeClock()
    const f = feed(clock)
    const marks: Array<{ key: string; price: number; ts: number }> = []
    f.on('mark', (m) => marks.push(m))
    f.start()
    FakeSocket.last.serverOpen()

    const frame = fixture('price-frame-btc.json')
    FakeSocket.last.serverSend(frame)
    FakeSocket.last.serverSend(frame)

    expect(marks).toHaveLength(1)
    expect(marks[0]).toEqual({
      key: 'P-BTC-USDC-3600:cross',
      price: 63555.71,
      ts: Date.parse('2026-08-13T15:56:14.566Z'),
    })

    // A new pricing timestamp is a new observation.
    const next = structuredClone(frame) as { pricing: { timestamp: string; price: string } }
    next.pricing.timestamp = '2026-08-13T15:56:15.566862Z'
    next.pricing.price = '63560.00'
    FakeSocket.last.serverSend(next)
    expect(marks).toHaveLength(2)
    expect(marks[1]?.price).toBe(63560)
  })

  it('exposes the index price alongside the mark', () => {
    const clock = new FakeClock()
    const f = feed(clock)
    let underlying: string | null | undefined
    f.on('pricing', (p) => {
      underlying = p.pricing.underlying_price
    })
    f.start()
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverSend(fixture('price-frame-btc.json'))
    expect(underlying).toBe('63586.14')
  })

  it('raises schema drift rather than guessing at a changed frame', () => {
    const clock = new FakeClock()
    const f = feed(clock)
    const drifts: SchemaDriftError[] = []
    f.on('schemaDrift', (d) => drifts.push(d))
    f.start()
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverSend({
      channel: 'instrument_price:P-BTC-USDC-3600',
      pricing: { price: 1 },
    })
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toBeInstanceOf(SchemaDriftError)
    expect(drifts[0]?.endpoint).toBe('ws /prices')
  })
})

describe('QuotesFeed', () => {
  it('re-sends the {instrument, qty} request on every OPEN and emits an unrounded mark', () => {
    const clock = new FakeClock()
    const f = new QuotesFeed({
      wsBaseUrl: WS,
      instrument: { symbol: 'BTC' },
      qty: '0.001',
      factory: fakeFactory,
      ...timers(clock),
    })
    const marks: number[] = []
    f.on('mark', (m) => marks.push(m.price))
    f.start()
    FakeSocket.last.serverOpen()

    expect(FakeSocket.last.url).toBe(`${WS}/quotes/simple`)
    expect(FakeSocket.last.sentJson[0]).toEqual({
      instrument: {
        underlying: 'BTC',
        instrument_type: 'perpetual_future',
        settlement_asset: 'USDC',
        funding_interval_s: 3600,
      },
      qty: '0.001',
    })

    FakeSocket.last.serverSend(fixture('quote-simple-btc.json'))
    // Full precision, unlike /prices which is display-rounded to 63555.71.
    expect(marks).toEqual([63346.7543455801])
    expect(f.current()?.quote_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')

    FakeSocket.last.serverClose()
    clock.advance(1)
    FakeSocket.last.serverOpen()
    expect(FakeSocket.last.sentJson).toHaveLength(1)
  })

  it('re-requests when the quoted size changes', () => {
    const clock = new FakeClock()
    const f = new QuotesFeed({
      wsBaseUrl: WS,
      instrument: { symbol: 'BTC' },
      qty: '0.001',
      factory: fakeFactory,
      ...timers(clock),
    })
    f.start()
    FakeSocket.last.serverOpen()
    f.setQty('0.002')
    expect(FakeSocket.last.sentJson).toHaveLength(2)
    expect((FakeSocket.last.sentJson[1] as { qty: string }).qty).toBe('0.002')
  })

  it('surfaces an {error} frame without pretending it was a quote', () => {
    const clock = new FakeClock()
    const f = new QuotesFeed({
      wsBaseUrl: WS,
      instrument: { symbol: 'BTC' },
      qty: '1',
      factory: fakeFactory,
      ...timers(clock),
    })
    const errors: unknown[] = []
    f.on('venueError', (e) => errors.push(e.error))
    f.start()
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverSend({ error: 'qty too large' })
    expect(errors).toEqual(['qty too large'])
  })

  it('pools one socket per instrument, because the path does not multiplex', () => {
    const clock = new FakeClock()
    const pool = new QuotesFeedPool({ wsBaseUrl: WS, factory: fakeFactory, ...timers(clock) })
    pool.track({ symbol: 'BTC' }, '0.001')
    pool.track({ symbol: 'ETH' }, '1')
    expect(FakeSocket.instances).toHaveLength(2)
    expect(pool.keys()).toEqual(['P-BTC-USDC-3600', 'P-ETH-USDC-3600'])

    pool.untrack({ symbol: 'ETH' })
    expect(pool.keys()).toEqual(['P-BTC-USDC-3600'])
    pool.stop()
  })
})

describe('authenticated feeds', () => {
  it('sends {claims} as the first frame on every OPEN', () => {
    const clock = new FakeClock()
    const events = new EventsFeed({
      wsBaseUrl: WS,
      token: () => 'jwt-token',
      factory: fakeFactory,
      ...timers(clock),
    })
    events.start()
    FakeSocket.last.serverOpen()
    expect(FakeSocket.last.url).toBe(`${WS}/events`)
    expect(FakeSocket.last.sentJson).toEqual([{ claims: 'jwt-token' }])

    FakeSocket.last.serverClose()
    clock.advance(1)
    FakeSocket.last.serverOpen()
    expect(FakeSocket.last.sentJson).toEqual([{ claims: 'jwt-token' }])
  })

  it('reports authFailed immediately when there is no token to send', () => {
    const clock = new FakeClock()
    const failures: string[] = []
    const events = new EventsFeed({
      wsBaseUrl: WS,
      token: () => undefined,
      factory: fakeFactory,
      ...timers(clock),
    })
    events.on('authFailed', (f) => failures.push(f.message))
    events.start()
    FakeSocket.last.serverOpen()
    expect(failures).toHaveLength(1)
    expect(FakeSocket.last.sent).toHaveLength(0)
  })

  it('recognises the venue token-rejection frames', () => {
    const clock = new FakeClock()
    const failures: string[] = []
    const events = new EventsFeed({
      wsBaseUrl: WS,
      token: () => 'bad',
      factory: fakeFactory,
      ...timers(clock),
    })
    events.on('authFailed', (f) => failures.push(f.message))
    events.start()
    FakeSocket.last.serverOpen()
    FakeSocket.last.serverSend('Token format incorrect, could not deserialize')
    expect(failures).toEqual(['Token format incorrect, could not deserialize'])
  })

  it('routes the six known /events types and surfaces unknown ones', () => {
    const clock = new FakeClock()
    const events = new EventsFeed({
      wsBaseUrl: WS,
      token: () => 'jwt',
      factory: fakeFactory,
      ...timers(clock),
    })
    const seen: string[] = []
    const unhandled: string[] = []
    events.on('trade', () => seen.push('trade'))
    events.on('liquidation', () => seen.push('liquidation'))
    events.on('clearing', () => seen.push('clearing'))
    events.on('transfer', () => seen.push('transfer'))
    events.on('canceledOrder', () => seen.push('canceledOrder'))
    events.on('slippageWarning', () => seen.push('slippageWarning'))
    events.on('allocationChange', () => seen.push('allocationChange'))
    events.on('unhandled', (u) => unhandled.push(u.type))
    events.start()
    FakeSocket.last.serverOpen()

    const instrument = { underlying: 'BTC', instrument_type: 'perpetual_future' }
    const socket = FakeSocket.last
    socket.serverSend({ type: 'trade', data: { source_rfq: 'r', instrument, trade_type: 'trade' } })
    socket.serverSend({
      type: 'trade',
      data: { source_rfq: 'r', instrument, trade_type: 'liquidation', role: 'taker' },
    })
    socket.serverSend({
      type: 'clearing_event',
      data: { rfq_id: 'r', taker_company: 'x', clearing_status: 'pending_clearing' },
    })
    socket.serverSend({ type: 'transfer', data: { transfer_type: 'funding', id: 't', qty: '1' } })
    socket.serverSend({ type: 'canceled_order', data: { order_id: 'o', rfq_id: 'r' } })
    socket.serverSend({ type: 'slippage_limit_warning', data: { rfq_id: 'r', slippage: '0.01' } })
    socket.serverSend({
      type: 'allocation_change',
      data: { conversion_id: 'c', status: 'pending' },
    })
    socket.serverSend({ type: 'something_new', data: { hello: true } })

    expect(seen).toEqual([
      'trade',
      'liquidation',
      'clearing',
      'transfer',
      'canceledOrder',
      'slippageWarning',
      'allocationChange',
    ])
    expect(unhandled).toEqual(['something_new'])
  })

  it('splits a /portfolio frame into its optional halves', () => {
    const clock = new FakeClock()
    const portfolio = new PortfolioFeed({
      wsBaseUrl: WS,
      token: () => 'jwt',
      factory: fakeFactory,
      ...timers(clock),
    })
    let positionCount = -1
    let balance: string | null | undefined
    portfolio.on('positions', (p) => {
      positionCount = p.length
    })
    portfolio.on('portfolio', (p) => {
      balance = p.balance
    })
    portfolio.start()
    FakeSocket.last.serverOpen()

    FakeSocket.last.serverSend({ positions: fixture('positions.json') })
    expect(positionCount).toBe(2)
    expect(balance).toBeUndefined()

    FakeSocket.last.serverSend({ pool_portfolio_result: fixture('portfolio.json') })
    expect(balance).toBe('10000.00')
  })
})

describe('discarding a socket that is still CONNECTING', () => {
  /**
   * `ws` aborts a CONNECTING handshake by emitting 'error' on a LATER tick. If
   * the handler has been detached, Node rethrows it as an uncaughtException.
   *
   * This killed a running process: a mark-feed flap left the socket CONNECTING,
   * the connect-timeout fired reconnect(), and the process exited with
   * "WebSocket was closed before the connection was established".
   */
  class AbortingSocket extends FakeSocket {
    override close(code?: number, reason?: string): void {
      const connecting = this.readyState === 0
      super.close(code, reason)
      if (!connecting) return
      // Exactly what ws does: defer, then emit on the socket.
      queueMicrotask(() => {
        const err = new Error('WebSocket was closed before the connection was established')
        if (this.onerror === null) throw err // what Node's EventEmitter does
        this.onerror(err)
      })
    }
  }

  it('leaves an error handler attached so a deferred abort cannot kill the process', async () => {
    FakeSocket.reset()
    const socket = new ManagedSocket({
      url: 'wss://example.test/prices',
      name: 'test',
      factory: (url) => new AbortingSocket(url),
      setTimeoutImpl: () => 0,
      clearTimeoutImpl: () => {},
    })
    socket.start()
    const raw = FakeSocket.last
    expect(raw.readyState).toBe(0) // still CONNECTING

    socket.reconnect('connect timeout')

    expect(raw.closedWith?.code).toBe(4000)
    // The listener MUST survive the close, or the deferred emit throws.
    expect(raw.onerror).not.toBeNull()
    await expect(
      Promise.resolve().then(() => new Promise((r) => queueMicrotask(() => r(null)))),
    ).resolves.toBeNull()

    socket.stop()
  })

  it('does the same on stop()', async () => {
    FakeSocket.reset()
    const socket = new ManagedSocket({
      url: 'wss://example.test/prices',
      name: 'test',
      factory: (url) => new AbortingSocket(url),
      setTimeoutImpl: () => 0,
      clearTimeoutImpl: () => {},
    })
    socket.start()
    const raw = FakeSocket.last
    socket.stop()
    expect(raw.closedWith?.code).toBe(1000)
    expect(raw.onerror).not.toBeNull()
  })
})
