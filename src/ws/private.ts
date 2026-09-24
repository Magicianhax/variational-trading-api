/**
 * The two authenticated sockets: `/events` and `/portfolio`.
 *
 * Authentication is a FIRST APPLICATION FRAME, not a header and not a cookie:
 *
 *     -> {"claims":"<jwt from GET /me>"}
 *
 * It must arrive within the venue's ~2.5 s deadline or you get
 * `Token timeout: Unauthorized` followed by an empty close frame. A malformed
 * or foreign-signed token gets `Token format incorrect, could not deserialize`.
 * The frame must be re-sent on every OPEN — the send queue does not survive a
 * reconnect.
 *
 * Consumption discipline (copied deliberately from the reference client, which
 * is right about this): **`/events` frames are cache-invalidation hints, never
 * state.** There are no sequence numbers anywhere in this protocol, so a gap is
 * undetectable; the only safe response to any event is to re-read REST. The
 * `/portfolio` frames are a MERGE over a REST-fetched base, not a snapshot.
 */

import type { z } from 'zod'
import { SchemaDriftError } from '../errors.js'
import type { Logger } from '../http.js'
import { noopLogger } from '../http.js'
import {
  allocationChangeEventSchema,
  canceledOrderEventSchema,
  clearingEventSchema,
  eventFrameSchema,
  type Portfolio,
  type Position,
  portfolioFrameSchema,
  slippageWarningEventSchema,
  tradeEventSchema,
  transferEventSchema,
} from '../schemas.js'
import { Emitter } from './emitter.js'
import { ManagedSocket, type SocketState, type WebSocketFactory } from './socket.js'

/** Text frames the venue sends when the `{claims}` handshake fails. */
const AUTH_FAILURE_MARKERS = [
  'Token timeout',
  'Token format incorrect',
  'No authentication received',
]

export type PrivateFeedOptions = {
  wsBaseUrl: string
  /** Resolves the JWT from `GET /me`. Called fresh on every OPEN. */
  token: () => string | undefined
  factory?: WebSocketFactory
  logger?: Logger
  silenceMs?: number
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
}

type BaseEvents = {
  /** No payload; `undefined` rather than `void` so the map stays a plain record. */
  open: undefined
  close: { code: number | undefined; reason: string | undefined; willReconnect: boolean }
  error: { error: unknown; phase: string }
  state: SocketState
  heartbeat: { timestamp: string }
  /** The venue refused our `{claims}` frame, or we had no token to send. */
  authFailed: { message: string }
  schemaDrift: SchemaDriftError
}

abstract class PrivateSocketFeed<Events extends BaseEvents> extends Emitter<Events> {
  readonly socket: ManagedSocket
  protected readonly logger: Logger
  private readonly token: () => string | undefined

  protected constructor(path: '/events' | '/portfolio', name: string, options: PrivateFeedOptions) {
    super()
    this.logger = options.logger ?? noopLogger
    this.token = options.token

    this.socket = new ManagedSocket({
      url: `${options.wsBaseUrl.replace(/\/+$/, '')}${path}`,
      name,
      silenceMs: options.silenceMs ?? 12_000,
      ...(options.factory === undefined ? {} : { factory: options.factory }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.setTimeoutImpl === undefined ? {} : { setTimeoutImpl: options.setTimeoutImpl }),
      ...(options.clearTimeoutImpl === undefined
        ? {}
        : { clearTimeoutImpl: options.clearTimeoutImpl }),
      onOpen: (socket) => this.authenticate(socket),
    })

    this.socket.on('message', (frame) => this.handleFrame(frame))
    this.socket.on('text', (text) => this.handleText(text))
    this.socket.on('open', () => this.emitBase('open', undefined))
    this.socket.on('close', (e) => this.emitBase('close', e))
    this.socket.on('error', (e) => this.emitBase('error', e))
    this.socket.on('state', (s) => this.emitBase('state', s))
    this.socket.on('heartbeat', (h) => this.emitBase('heartbeat', h))
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

  private authenticate(socket: ManagedSocket): void {
    const token = this.token()
    if (token === undefined || token === '') {
      // Sending nothing guarantees a 2.5 s timeout close; say so immediately so
      // the caller can go fetch a session instead of watching a reconnect loop.
      this.logger.error('ws.noToken', { name: socket.name })
      this.emitAuthFailed('no session token available for the {claims} handshake')
      return
    }
    socket.send({ claims: token })
  }

  private handleText(text: string): void {
    if (AUTH_FAILURE_MARKERS.some((marker) => text.includes(marker))) {
      this.logger.error('ws.authFailed', { name: this.socket.name, text })
      this.emitAuthFailed(text)
      return
    }
    this.logger.warn('ws.text', { name: this.socket.name, text })
  }

  /**
   * Emit one of the shared base events from the generic base class. The casts
   * are the price of a base class that is generic over its subclass's event
   * map; `Events extends BaseEvents` guarantees they are sound.
   */
  protected emitBase<K extends keyof BaseEvents>(event: K, payload: BaseEvents[K]): void {
    this.emit(event as unknown as keyof Events, payload as unknown as Events[keyof Events])
  }

  protected emitAuthFailed(message: string): void {
    this.emitBase('authFailed', { message })
  }

  protected emitDrift(endpoint: string, issues: SchemaDriftError['issues'], raw: unknown): void {
    const error = new SchemaDriftError({ endpoint, issues, raw })
    this.logger.error('ws.schemaDrift', { endpoint, message: error.message })
    this.emitBase('schemaDrift', error)
  }

  protected abstract handleFrame(frame: unknown): void
}

/* -------------------------------------------------------------------------- */
/* /events                                                                    */
/* -------------------------------------------------------------------------- */

export type TradeEvent = z.infer<typeof tradeEventSchema>
export type ClearingEvent = z.infer<typeof clearingEventSchema>
export type TransferEvent = z.infer<typeof transferEventSchema>
export type CanceledOrderEvent = z.infer<typeof canceledOrderEventSchema>
export type SlippageWarningEvent = z.infer<typeof slippageWarningEventSchema>
export type AllocationChangeEvent = z.infer<typeof allocationChangeEventSchema>

export type EventsFeedEvents = BaseEvents & {
  trade: TradeEvent
  liquidation: TradeEvent
  clearing: ClearingEvent
  transfer: TransferEvent
  canceledOrder: CanceledOrderEvent
  slippageWarning: SlippageWarningEvent
  allocationChange: AllocationChangeEvent
  /**
   * Every frame, handled or not — including `type` values the six known
   * handlers ignore. The reference client drops those silently, which is
   * exactly why the full vocabulary is still unknown. We surface them.
   */
  raw: { type: string; data: unknown }
  /** A `type` we have no handler for. Log these; they close a known unknown. */
  unhandled: { type: string; data: unknown }
}

export class EventsFeed extends PrivateSocketFeed<EventsFeedEvents> {
  constructor(options: PrivateFeedOptions) {
    super('/events', 'realtimeUpdates', options)
  }

  protected override handleFrame(frame: unknown): void {
    const envelope = eventFrameSchema.safeParse(frame)
    if (!envelope.success) {
      this.emitDrift('ws /events', envelope.error.issues, frame)
      return
    }
    const { type, data } = envelope.data
    this.emit('raw', { type, data })

    switch (type) {
      case 'trade': {
        const parsed = tradeEventSchema.safeParse(data)
        if (!parsed.success) {
          this.emitDrift('ws /events trade', parsed.error.issues, data)
          return
        }
        if (parsed.data.trade_type === 'liquidation') this.emit('liquidation', parsed.data)
        else this.emit('trade', parsed.data)
        return
      }
      case 'clearing_event': {
        const parsed = clearingEventSchema.safeParse(data)
        if (!parsed.success) {
          this.emitDrift('ws /events clearing_event', parsed.error.issues, data)
          return
        }
        this.emit('clearing', parsed.data)
        return
      }
      case 'transfer': {
        const parsed = transferEventSchema.safeParse(data)
        if (!parsed.success) {
          this.emitDrift('ws /events transfer', parsed.error.issues, data)
          return
        }
        this.emit('transfer', parsed.data)
        return
      }
      case 'canceled_order': {
        const parsed = canceledOrderEventSchema.safeParse(data)
        if (!parsed.success) {
          this.emitDrift('ws /events canceled_order', parsed.error.issues, data)
          return
        }
        this.emit('canceledOrder', parsed.data)
        return
      }
      case 'slippage_limit_warning': {
        const parsed = slippageWarningEventSchema.safeParse(data)
        if (!parsed.success) {
          this.emitDrift('ws /events slippage_limit_warning', parsed.error.issues, data)
          return
        }
        this.emit('slippageWarning', parsed.data)
        return
      }
      case 'allocation_change': {
        const parsed = allocationChangeEventSchema.safeParse(data)
        if (!parsed.success) {
          this.emitDrift('ws /events allocation_change', parsed.error.issues, data)
          return
        }
        this.emit('allocationChange', parsed.data)
        return
      }
      default:
        this.logger.warn('events.unhandledType', { type })
        this.emit('unhandled', { type, data })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* /portfolio                                                                 */
/* -------------------------------------------------------------------------- */

export type PortfolioFeedEvents = BaseEvents & {
  /** Full replacement of the positions array as far as the venue is concerned. */
  positions: Position[]
  /** PARTIAL portfolio — merge it over the REST-fetched base, do not replace. */
  portfolio: Portfolio
  frame: { positions: Position[] | undefined; portfolio: Portfolio | undefined }
}

export class PortfolioFeed extends PrivateSocketFeed<PortfolioFeedEvents> {
  constructor(options: PrivateFeedOptions) {
    super('/portfolio', 'portfolio', options)
  }

  protected override handleFrame(frame: unknown): void {
    const parsed = portfolioFrameSchema.safeParse(frame)
    if (!parsed.success) {
      this.emitDrift('ws /portfolio', parsed.error.issues, frame)
      return
    }
    const positions = parsed.data.positions ?? undefined
    const portfolio = parsed.data.pool_portfolio_result ?? undefined
    this.emit('frame', { positions, portfolio })
    if (positions !== undefined) this.emit('positions', positions)
    if (portfolio !== undefined) this.emit('portfolio', portfolio)
  }
}
