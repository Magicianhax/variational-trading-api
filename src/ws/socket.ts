/**
 * `ManagedSocket` — the reconnecting WebSocket every Omni feed is built on.
 *
 * Protocol facts this encodes (all live-verified during recon):
 *
 *  - No subprotocol, no query string, no auth in the URL. `/events` and
 *    `/portfolio` authenticate with a FIRST APPLICATION FRAME `{"claims":jwt}`
 *    inside a ~2.5 s server-side deadline.
 *  - The server heartbeats every 5.000 s on `/prices`, `/events`, `/portfolio`
 *    (on a global wall clock, identical sub-second across connections) but NOT
 *    on `/quotes/simple`, which is silent until you ask it something.
 *  - There are no RFC-6455 PING/PONGs and no client-side heartbeat. Liveness is
 *    an inbound-silence watchdog only.
 *  - The send queue does NOT survive a reconnect, so `{claims}` and
 *    `{"action":"subscribe"}` must be re-sent on every OPEN. That is what
 *    `onOpen` is for.
 *
 * Two behaviours of the reference client are deliberately NOT copied:
 *
 *  1. Its 30-minute user-idle teardown — browser-tab hygiene, not protocol, and
 *     fatal for an unattended process.
 *  2. Its dead guard comparing the first frame to a string the server no longer
 *     sends; the real message falls through, is thrown away by an empty
 *     `catch {}`, and marks the connection HEALTHY right before it dies. We
 *     surface every non-JSON frame instead.
 */

import WebSocket from 'ws'
import type { Logger } from '../http.js'
import { noopLogger } from '../http.js'
import { Emitter } from './emitter.js'

export const SOCKET_OPEN = 1

/** The slice of the WebSocket API this module uses. */
export type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type WebSocketFactory = (url: string) => WebSocketLike

export type SocketState = 'idle' | 'connecting' | 'open' | 'closed'

export type ManagedSocketEvents = {
  /** No payload; `undefined` rather than `void` so the map stays a plain record. */
  open: undefined
  /** A JSON frame. Heartbeats are filtered out and emitted as `heartbeat`. */
  message: unknown
  /** A frame that was not valid JSON — the venue uses these for auth errors. */
  text: string
  heartbeat: { timestamp: string }
  close: { code: number | undefined; reason: string | undefined; willReconnect: boolean }
  error: { error: unknown; phase: 'connect' | 'socket' | 'send' }
  state: SocketState
  reconnect: { attempt: number; delayMs: number }
}

export type ManagedSocketOptions = {
  url: string
  /** Human name used in logs and health reporting (`marketData`, `portfolio`, ...). */
  name: string
  factory?: WebSocketFactory
  logger?: Logger
  /**
   * Inbound-silence watchdog. 12 000 ms on the heartbeat-bearing paths (two
   * missed 5 s beats plus margin); ~3 000 ms on `/quotes/simple`, which has no
   * heartbeats but streams at 1 Hz. `0` disables it.
   */
  silenceMs?: number
  /** A stalled handshake is abandoned after this long. */
  connectTimeoutMs?: number
  /** First retry is immediate; then `minDelayMs * 2^(n-1)`, capped. */
  minDelayMs?: number
  maxDelayMs?: number
  /** Called on every OPEN, before the queue is flushed: re-auth and re-subscribe here. */
  onOpen?: (socket: ManagedSocket) => void
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
}

export class ManagedSocket extends Emitter<ManagedSocketEvents> {
  readonly name: string
  readonly url: string

  private readonly factory: WebSocketFactory
  private readonly logger: Logger
  private readonly silenceMs: number
  private readonly connectTimeoutMs: number
  private readonly minDelayMs: number
  private readonly maxDelayMs: number
  private readonly onOpenHook: ((socket: ManagedSocket) => void) | undefined
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown
  private readonly clearTimeoutImpl: (handle: unknown) => void

  private socket: WebSocketLike | null = null
  private stateValue: SocketState = 'idle'
  private stopped = true
  private attempt = 0
  private queue: string[] = []
  private silenceTimer: unknown = null
  private connectTimer: unknown = null
  private reconnectTimer: unknown = null

  constructor(options: ManagedSocketOptions) {
    super()
    this.url = options.url
    this.name = options.name
    this.factory = options.factory ?? defaultFactory
    this.logger = options.logger ?? noopLogger
    this.silenceMs = options.silenceMs ?? 12_000
    this.connectTimeoutMs = options.connectTimeoutMs ?? 4_000
    this.minDelayMs = options.minDelayMs ?? 1_000
    this.maxDelayMs = options.maxDelayMs ?? 60_000
    this.onOpenHook = options.onOpen
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutImpl =
      options.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  get state(): SocketState {
    return this.stateValue
  }

  get isOpen(): boolean {
    return this.stateValue === 'open'
  }

  /** Connection attempts since the last successful OPEN. */
  get retryCount(): number {
    return this.attempt
  }

  /** Connect, and keep reconnecting until {@link stop} is called. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.connect()
  }

  /** Close and stay closed. Clears the pending send queue. */
  stop(): void {
    this.stopped = true
    this.clearTimer('reconnectTimer')
    this.clearTimer('connectTimer')
    this.clearTimer('silenceTimer')
    this.queue = []
    const socket = this.socket
    this.socket = null
    if (socket !== null) discard(socket, 1000, 'client shutdown')
    this.setState('closed')
  }

  /** Force a reconnect now (used by the silence watchdog and by feed managers). */
  reconnect(reason: string): void {
    if (this.stopped) return
    this.logger.warn('ws.forceReconnect', { name: this.name, reason })
    const socket = this.socket
    this.socket = null
    if (socket !== null) discard(socket, 4000, reason)
    this.clearTimer('silenceTimer')
    this.clearTimer('connectTimer')
    this.scheduleReconnect()
  }

  /**
   * Send a JSON frame. Queued while connecting; the queue is DROPPED on close,
   * because the venue expects state-establishing frames to be re-sent on the
   * next OPEN rather than replayed late.
   */
  send(payload: unknown): void {
    const data = JSON.stringify(payload)
    if (this.socket !== null && this.socket.readyState === SOCKET_OPEN) {
      try {
        this.socket.send(data)
      } catch (err) {
        this.emit('error', { error: err, phase: 'send' })
      }
      return
    }
    this.queue.push(data)
  }

  private setState(state: SocketState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.emit('state', state)
  }

  private connect(): void {
    if (this.stopped) return
    this.setState('connecting')

    let socket: WebSocketLike
    try {
      socket = this.factory(this.url)
    } catch (err) {
      this.emit('error', { error: err, phase: 'connect' })
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    this.connectTimer = this.setTimeoutImpl(() => {
      if (this.socket === socket && this.stateValue !== 'open') {
        this.logger.warn('ws.connectTimeout', { name: this.name, ms: this.connectTimeoutMs })
        this.reconnect('connect timeout')
      }
    }, this.connectTimeoutMs)

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.clearTimer('connectTimer')
      this.attempt = 0
      this.setState('open')
      this.armSilenceWatchdog()
      this.emit('open', undefined)
      // The hook re-authenticates and re-subscribes; its sends jump the queue
      // because they establish the session the queued frames assume.
      this.onOpenHook?.(this)
      const pending = this.queue
      this.queue = []
      for (const frame of pending) {
        try {
          socket.send(frame)
        } catch (err) {
          this.emit('error', { error: err, phase: 'send' })
        }
      }
    }

    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.armSilenceWatchdog()
      const raw = toText(event.data)
      if (raw === null) return
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // NOT dead code: this is how the venue delivers
        // "Token timeout: Unauthorized" and "unsupported instrument: ...".
        this.emit('text', raw)
        return
      }
      if (isHeartbeat(parsed)) {
        this.emit('heartbeat', { timestamp: parsed.timestamp })
        return
      }
      this.emit('message', parsed)
    }

    socket.onerror = (err) => {
      if (this.socket !== socket) return
      this.emit('error', { error: err, phase: 'socket' })
    }

    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      detach(socket)
      this.clearTimer('connectTimer')
      this.clearTimer('silenceTimer')
      this.queue = []
      const willReconnect = !this.stopped
      this.setState('closed')
      this.emit('close', { code: event.code, reason: event.reason, willReconnect })
      if (willReconnect) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.clearTimer('reconnectTimer')
    this.attempt += 1
    // First attempt is immediate, matching the reference client's `_retryCount`
    // starting below zero; after that, exponential with a hard cap.
    const delay =
      this.attempt <= 1 ? 0 : Math.min(this.maxDelayMs, this.minDelayMs * 2 ** (this.attempt - 2))
    this.emit('reconnect', { attempt: this.attempt, delayMs: delay })
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private armSilenceWatchdog(): void {
    if (this.silenceMs <= 0) return
    this.clearTimer('silenceTimer')
    this.silenceTimer = this.setTimeoutImpl(() => {
      this.silenceTimer = null
      this.reconnect(`no inbound frame for ${this.silenceMs}ms`)
    }, this.silenceMs)
  }

  private clearTimer(field: 'silenceTimer' | 'connectTimer' | 'reconnectTimer'): void {
    const handle = this[field]
    if (handle !== null) {
      this.clearTimeoutImpl(handle)
      this[field] = null
    }
  }
}

function detach(socket: WebSocketLike): void {
  socket.onopen = null
  socket.onmessage = null
  socket.onclose = null
  socket.onerror = null
}

/**
 * Detach from a socket we are done with and close it, without ever letting it
 * take the process down.
 *
 * Closing a socket that is still CONNECTING makes `ws` abort the handshake and
 * emit `'error'` — but on a LATER tick (`abortHandshake` defers via
 * `process.nextTick`). By then this function's `try` has already returned, so a
 * `try/catch` around `close()` cannot catch it. If the error handler has been
 * detached, Node's EventEmitter rethrows the unhandled `'error'` as an
 * uncaughtException and the whole process dies.
 *
 * Observed live: a mark-feed flap put the socket in CONNECTING, the silence
 * watchdog fired `reconnect()`, and the process exited with
 * "WebSocket was closed before the connection was established" — a routine feed
 * hiccup turned into a dead bot.
 *
 * So we keep a no-op `onerror` attached across the close instead of nulling it.
 */
function discard(socket: WebSocketLike, code: number, reason: string): void {
  socket.onopen = null
  socket.onmessage = null
  socket.onclose = null
  // Deliberately NOT null — see above.
  socket.onerror = () => {}
  try {
    socket.close(code, reason)
  } catch {
    /* already dead */
  }
}

function toText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  if (Array.isArray(data)) {
    // `ws` delivers fragmented binary as Buffer[].
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk as Uint8Array))).toString('utf8')
  }
  return null
}

function isHeartbeat(value: unknown): value is { type: 'heartbeat'; timestamp: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'heartbeat' &&
    typeof (value as { timestamp?: unknown }).timestamp === 'string'
  )
}

/**
 * Default factory. Uses the `ws` package rather than Node's global WebSocket so
 * a caller can add an `Origin`/UA header set if Cloudflare's posture changes
 * — the WS host has no bot challenge today, but the API host does.
 *
 * An empty protocol list is passed deliberately: the reference client does
 * `new WebSocket(url, [])`, and the server negotiates no subprotocol.
 */
function defaultFactory(url: string): WebSocketLike {
  return new WebSocket(url, []) as unknown as WebSocketLike
}
