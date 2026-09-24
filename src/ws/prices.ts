/**
 * `/prices` — the breadth mark-price feed.
 *
 * One socket multiplexes every subscribed instrument at ~1 Hz. Hard-won rules,
 * every one of them live-verified, every one of them fatal if broken:
 *
 *  1. `funding_interval_s` in the subscribe frame is ALWAYS 3600, even when the
 *     market's real funding interval is 28800. `P-ANKR-USDC-28800` is rejected.
 *  2. A single unknown instrument kills the WHOLE socket
 *     (`unsupported instrument: <key>`), and if that leaves zero subscriptions
 *     the server closes the connection.
 *  3. Unsubscribing your LAST instrument also closes the connection. A sentinel
 *     instrument is therefore kept subscribed permanently.
 *  4. Subscribe/unsubscribe are not acked; the first tick lands 0.2–1.1 s later.
 *  5. `pricing.timestamp` lags and REPEATS — dedupe on it, never on arrival.
 *
 * `pricing.price` is the perp MARK price, but rounded to display precision
 * (BTC arrives as `63555.71`). For trigger-grade precision use
 * {@link QuotesFeed}, which carries an unrounded `mark_price`.
 */

import { SchemaDriftError } from '../errors.js'
import type { Logger } from '../http.js'
import { noopLogger } from '../http.js'
import {
  asInstrumentKey,
  type InstrumentInput,
  type InstrumentKey,
  type InstrumentObject,
  instrumentKey,
  instrumentObject,
  positionKey,
} from '../instrument.js'
import { type Pricing, priceFrameSchema } from '../schemas.js'
import type { MarkTick } from '../types.js'
import { parseTimestamp } from '../wire.js'
import { Emitter } from './emitter.js'
import { ManagedSocket, type SocketState, type WebSocketFactory } from './socket.js'

/** The venue's price channels are prefixed; strip it before using the key. */
const CHANNEL_PREFIX = 'instrument_price:'

/** Server text frame emitted when a subscribe names an instrument it does not know. */
const UNSUPPORTED_PREFIX = 'unsupported instrument:'

export type PricesFeedEvents = {
  /** Normalised mark-price tick. */
  mark: MarkTick
  /** The full pricing payload, including `underlying_price` (the index). */
  pricing: { key: InstrumentKey; positionKey: string; pricing: Pricing }
  /** The venue rejected an instrument key. The socket is about to die. */
  unsupported: { key: string; message: string }
  /** A frame did not match its schema — stop and look, never guess. */
  schemaDrift: SchemaDriftError
  /** No payload; `undefined` rather than `void` so the map stays a plain record. */
  open: undefined
  close: { code: number | undefined; reason: string | undefined; willReconnect: boolean }
  error: { error: unknown; phase: string }
  state: SocketState
  heartbeat: { timestamp: string }
}

export type PricesFeedOptions = {
  /** `wss://omni-ws-server.prod.ap-northeast-1.variational.io` */
  wsBaseUrl: string
  factory?: WebSocketFactory
  logger?: Logger
  /**
   * Permanently subscribed so an unsubscribe can never empty the set and close
   * the socket. Defaults to BTC, which is always listed.
   */
  sentinel?: InstrumentInput
  /** Sub-account component of the emitted `MarkTick.key`. */
  subAccount?: string
  /** Two missed 5 s heartbeats plus margin. */
  silenceMs?: number
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
  /**
   * Optional guard run before every subscribe. Return false to refuse a key —
   * wire this to `/metadata/supported_assets` so an unknown symbol can never
   * take the socket down.
   */
  isSupported?: (key: InstrumentKey) => boolean
}

export class PricesFeed extends Emitter<PricesFeedEvents> {
  readonly socket: ManagedSocket

  private readonly logger: Logger
  private readonly subAccount: string
  private readonly isSupported: (key: InstrumentKey) => boolean
  private readonly sentinelKey: InstrumentKey

  /** What we want subscribed. Always contains the sentinel. */
  private readonly desired = new Map<InstrumentKey, InstrumentObject>()
  /** What the server believes is subscribed (best effort — nothing is acked). */
  private readonly active = new Set<InstrumentKey>()
  /** Last accepted pricing timestamp per key, for de-duplication. */
  private readonly lastTs = new Map<InstrumentKey, string>()
  private readonly latest = new Map<InstrumentKey, Pricing>()

  constructor(options: PricesFeedOptions) {
    super()
    this.logger = options.logger ?? noopLogger
    this.subAccount = options.subAccount ?? 'cross'
    this.isSupported = options.isSupported ?? (() => true)

    const sentinel = instrumentObject(
      options.sentinel ?? { symbol: 'BTC', instrument_type: 'perpetual_future' },
    )
    this.sentinelKey = instrumentKey(sentinel)
    this.desired.set(this.sentinelKey, sentinel)

    this.socket = new ManagedSocket({
      url: `${options.wsBaseUrl.replace(/\/+$/, '')}/prices`,
      name: 'marketData',
      silenceMs: options.silenceMs ?? 12_000,
      ...(options.factory === undefined ? {} : { factory: options.factory }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.setTimeoutImpl === undefined ? {} : { setTimeoutImpl: options.setTimeoutImpl }),
      ...(options.clearTimeoutImpl === undefined
        ? {}
        : { clearTimeoutImpl: options.clearTimeoutImpl }),
      onOpen: () => this.resubscribeAll(),
    })

    this.socket.on('message', (frame) => this.handleFrame(frame))
    this.socket.on('text', (text) => this.handleText(text))
    this.socket.on('open', () => this.emit('open', undefined))
    this.socket.on('close', (e) => {
      this.active.clear()
      this.emit('close', e)
    })
    this.socket.on('error', (e) => this.emit('error', e))
    this.socket.on('state', (s) => this.emit('state', s))
    this.socket.on('heartbeat', (h) => this.emit('heartbeat', h))
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

  /** Keys currently requested (including the sentinel). */
  subscriptions(): InstrumentKey[] {
    return [...this.desired.keys()]
  }

  /** Most recent pricing payload for a key, if one has arrived. */
  lastPricing(key: InstrumentKey): Pricing | undefined {
    return this.latest.get(key)
  }

  /** Add instruments to the subscription set. */
  subscribe(instruments: readonly InstrumentInput[]): void {
    const added: InstrumentObject[] = []
    for (const input of instruments) {
      const instrument = instrumentObject(input)
      const key = instrumentKey(instrument)
      if (!this.isSupported(key)) {
        this.logger.warn('prices.refusedUnsupported', { key })
        continue
      }
      if (this.desired.has(key)) continue
      this.desired.set(key, instrument)
      added.push(instrument)
    }
    if (added.length > 0 && this.socket.isOpen) this.sendSubscribe(added)
  }

  /**
   * Remove instruments. The sentinel is never removed, so the set can never
   * become empty and the socket can never be closed by us.
   */
  unsubscribe(instruments: readonly InstrumentInput[]): void {
    const removed: InstrumentObject[] = []
    for (const input of instruments) {
      const key = instrumentKey(input)
      if (key === this.sentinelKey) continue
      const instrument = this.desired.get(key)
      if (instrument === undefined) continue
      this.desired.delete(key)
      this.lastTs.delete(key)
      removed.push(instrument)
    }
    if (removed.length > 0 && this.socket.isOpen) this.sendUnsubscribe(removed)
  }

  /** Replace the whole subscription set (sentinel is re-added automatically). */
  setSubscriptions(instruments: readonly InstrumentInput[]): void {
    const next = new Map<InstrumentKey, InstrumentObject>()
    for (const input of instruments) {
      const instrument = instrumentObject(input)
      next.set(instrumentKey(instrument), instrument)
    }
    const toRemove = [...this.desired.keys()].filter((k) => !next.has(k) && k !== this.sentinelKey)
    const toAdd = [...next.keys()].filter((k) => !this.desired.has(k))
    if (toRemove.length > 0)
      this.unsubscribe(toRemove.map((k) => this.desired.get(k)).filter(isDefined))
    this.subscribe(toAdd.map((k) => next.get(k)).filter(isDefined))
  }

  private resubscribeAll(): void {
    this.active.clear()
    const all = [...this.desired.values()]
    if (all.length > 0) this.sendSubscribe(all)
  }

  private sendSubscribe(instruments: readonly InstrumentObject[]): void {
    this.socket.send({ action: 'subscribe', instruments })
    for (const instrument of instruments) this.active.add(instrumentKey(instrument))
  }

  private sendUnsubscribe(instruments: readonly InstrumentObject[]): void {
    this.socket.send({ action: 'unsubscribe', instruments })
    for (const instrument of instruments) this.active.delete(instrumentKey(instrument))
  }

  private handleFrame(frame: unknown): void {
    const parsed = priceFrameSchema.safeParse(frame)
    if (!parsed.success) {
      const error = new SchemaDriftError({
        endpoint: 'ws /prices',
        issues: parsed.error.issues,
        raw: frame,
      })
      this.logger.error('prices.schemaDrift', { message: error.message })
      this.emit('schemaDrift', error)
      return
    }

    const channel = parsed.data.channel
    const rawKey = channel.startsWith(CHANNEL_PREFIX)
      ? channel.slice(CHANNEL_PREFIX.length)
      : channel
    let key: InstrumentKey
    try {
      key = asInstrumentKey(rawKey)
    } catch {
      this.logger.warn('prices.unknownChannel', { channel })
      return
    }

    const pricing = parsed.data.pricing
    this.latest.set(key, pricing)
    this.emit('pricing', { key, positionKey: positionKey(key, this.subAccount), pricing })

    // The venue re-pushes identical payloads; a duplicate must not look like a
    // fresh observation to the staleness guard.
    if (this.lastTs.get(key) === pricing.timestamp) return
    this.lastTs.set(key, pricing.timestamp)

    const ts = parseTimestamp(pricing.timestamp)
    const price = Number(pricing.price)
    if (ts === undefined || !Number.isFinite(price)) {
      this.logger.warn('prices.unusableTick', { key, price: pricing.price, ts: pricing.timestamp })
      return
    }
    this.emit('mark', { key: positionKey(key, this.subAccount), price, ts })
  }

  private handleText(text: string): void {
    if (text.startsWith(UNSUPPORTED_PREFIX)) {
      const key = text.slice(UNSUPPORTED_PREFIX.length).trim()
      this.logger.error('prices.unsupportedInstrument', { key })
      // Drop it so the reconnect does not immediately re-kill the socket.
      try {
        const parsedKey = asInstrumentKey(key)
        if (parsedKey !== this.sentinelKey) {
          this.desired.delete(parsedKey)
          this.active.delete(parsedKey)
        }
      } catch {
        /* unparseable key: nothing to drop */
      }
      this.emit('unsupported', { key, message: text })
      return
    }
    this.logger.warn('prices.text', { text })
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
