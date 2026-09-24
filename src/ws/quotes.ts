/**
 * `/quotes/simple` over WebSocket — undocumented, unauthenticated, and the best
 * mark-price source the venue has.
 *
 * Live-verified behaviour:
 *  - Send `{instrument, qty}` and it streams a full quote at ~1 Hz until you
 *    replace it.
 *  - ONE STREAM PER SOCKET: a second `{instrument, qty}` SWITCHES the stream, it
 *    does not multiplex. Hence {@link QuotesFeedPool}: one socket per traded
 *    instrument.
 *  - NO HEARTBEATS on this path at all (25 s idle produced zero frames), so the
 *    silence watchdog is short and is only meaningful once a request is in
 *    flight.
 *  - `mark_price` here is FULL PRECISION (`63346.7543455801`), unlike
 *    `/prices.price` which is display-rounded. `index_price`, `bid`, `ask` and a
 *    fresh `quote_id` come along for free.
 *
 * TODO(live): whether an anonymously-minted `quote_id` is accepted by
 * `/orders/new/market` or `/quotes/accept` is unconfirmed.
 */

import { SchemaDriftError } from '../errors.js'
import type { Logger } from '../http.js'
import { noopLogger } from '../http.js'
import {
  type InstrumentInput,
  type InstrumentKey,
  type InstrumentObject,
  instrumentKey,
  instrumentObject,
  positionKey,
} from '../instrument.js'
import { type Quote, quoteSchema, wsErrorFrameSchema } from '../schemas.js'
import type { MarkTick } from '../types.js'
import { parseTimestamp } from '../wire.js'
import { Emitter } from './emitter.js'
import { ManagedSocket, type SocketState, type WebSocketFactory } from './socket.js'

export type QuotesFeedEvents = {
  quote: { key: InstrumentKey; quote: Quote }
  /** Unrounded mark. Prefer this over `/prices`, which is display-rounded. */
  mark: MarkTick
  venueError: { error: unknown }
  schemaDrift: SchemaDriftError
  /** No payload; `undefined` rather than `void` so the map stays a plain record. */
  open: undefined
  close: { code: number | undefined; reason: string | undefined; willReconnect: boolean }
  error: { error: unknown; phase: string }
  state: SocketState
}

export type QuotesFeedOptions = {
  wsBaseUrl: string
  instrument: InstrumentInput
  /** The size the quote is minted for. Affects `bid`/`ask`, not `mark_price`. */
  qty: string | number
  factory?: WebSocketFactory
  logger?: Logger
  subAccount?: string
  /** No heartbeats on this path; 1 Hz data means ~3 s is already generous. */
  silenceMs?: number
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
}

export class QuotesFeed extends Emitter<QuotesFeedEvents> {
  readonly socket: ManagedSocket
  readonly key: InstrumentKey

  private readonly logger: Logger
  private readonly subAccount: string
  private instrument: InstrumentObject
  private qty: string
  private lastQuote: Quote | undefined

  constructor(options: QuotesFeedOptions) {
    super()
    this.logger = options.logger ?? noopLogger
    this.subAccount = options.subAccount ?? 'cross'
    this.instrument = instrumentObject(options.instrument)
    this.key = instrumentKey(this.instrument)
    this.qty = String(options.qty)

    this.socket = new ManagedSocket({
      url: `${options.wsBaseUrl.replace(/\/+$/, '')}/quotes/simple`,
      name: `quote:${this.key}`,
      silenceMs: options.silenceMs ?? 3_000,
      ...(options.factory === undefined ? {} : { factory: options.factory }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.setTimeoutImpl === undefined ? {} : { setTimeoutImpl: options.setTimeoutImpl }),
      ...(options.clearTimeoutImpl === undefined
        ? {}
        : { clearTimeoutImpl: options.clearTimeoutImpl }),
      // The request does not survive a reconnect; re-send it on every OPEN.
      onOpen: () => this.sendRequest(),
    })

    this.socket.on('message', (frame) => this.handleFrame(frame))
    this.socket.on('text', (text) => this.logger.warn('quotes.text', { key: this.key, text }))
    this.socket.on('open', () => this.emit('open', undefined))
    this.socket.on('close', (e) => this.emit('close', e))
    this.socket.on('error', (e) => this.emit('error', e))
    this.socket.on('state', (s) => this.emit('state', s))
  }

  start(): void {
    this.socket.start()
  }

  stop(): void {
    this.socket.stop()
  }

  get state(): SocketState {
    return this.socket.state
  }

  /** Most recent quote, or `undefined` before the first frame. */
  current(): Quote | undefined {
    return this.lastQuote
  }

  /** Change the quoted size (e.g. after a partial close). Re-requests immediately. */
  setQty(qty: string | number): void {
    this.qty = String(qty)
    if (this.socket.isOpen) this.sendRequest()
  }

  private sendRequest(): void {
    this.socket.send({ instrument: this.instrument, qty: this.qty })
  }

  private handleFrame(frame: unknown): void {
    const asError = wsErrorFrameSchema.safeParse(frame)
    if (asError.success && asError.data.error !== undefined) {
      this.logger.warn('quotes.venueError', { key: this.key, error: asError.data.error })
      this.emit('venueError', { error: asError.data.error })
      return
    }

    const parsed = quoteSchema.safeParse(frame)
    if (!parsed.success) {
      const error = new SchemaDriftError({
        endpoint: 'ws /quotes/simple',
        issues: parsed.error.issues,
        raw: frame,
      })
      this.logger.error('quotes.schemaDrift', { key: this.key, message: error.message })
      this.emit('schemaDrift', error)
      return
    }

    const quote = parsed.data
    this.lastQuote = quote
    this.emit('quote', { key: this.key, quote })

    const mark = quote.mark_price == null ? Number.NaN : Number(quote.mark_price)
    const ts = parseTimestamp(quote.timestamp)
    if (!Number.isFinite(mark) || ts === undefined) return
    this.emit('mark', { key: positionKey(this.key, this.subAccount), price: mark, ts })
  }
}

/**
 * One {@link QuotesFeed} per instrument, because the path does not multiplex.
 * The pool re-emits every child's `mark` on a single surface, so a caller subscribes
 * once for many instruments.
 */
export class QuotesFeedPool extends Emitter<QuotesFeedEvents> {
  private readonly feeds = new Map<InstrumentKey, QuotesFeed>()

  constructor(private readonly options: Omit<QuotesFeedOptions, 'instrument' | 'qty'>) {
    super()
  }

  /** Open (or resize) a stream for one instrument. */
  track(instrument: InstrumentInput, qty: string | number): QuotesFeed {
    const key = instrumentKey(instrument)
    const existing = this.feeds.get(key)
    if (existing !== undefined) {
      existing.setQty(qty)
      return existing
    }
    const feed = new QuotesFeed({ ...this.options, instrument, qty })
    feed.on('quote', (p) => this.emit('quote', p))
    feed.on('mark', (p) => this.emit('mark', p))
    feed.on('venueError', (p) => this.emit('venueError', p))
    feed.on('schemaDrift', (p) => this.emit('schemaDrift', p))
    feed.on('open', () => this.emit('open', undefined))
    feed.on('close', (p) => this.emit('close', p))
    feed.on('error', (p) => this.emit('error', p))
    feed.on('state', (p) => this.emit('state', p))
    this.feeds.set(key, feed)
    feed.start()
    return feed
  }

  untrack(instrument: InstrumentInput | InstrumentKey): void {
    const key =
      typeof instrument === 'string' ? (instrument as InstrumentKey) : instrumentKey(instrument)
    const feed = this.feeds.get(key)
    if (feed === undefined) return
    feed.stop()
    feed.removeAllListeners()
    this.feeds.delete(key)
  }

  get(key: InstrumentKey): QuotesFeed | undefined {
    return this.feeds.get(key)
  }

  keys(): InstrumentKey[] {
    return [...this.feeds.keys()]
  }

  stop(): void {
    for (const feed of this.feeds.values()) {
      feed.stop()
      feed.removeAllListeners()
    }
    this.feeds.clear()
  }
}
