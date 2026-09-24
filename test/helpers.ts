/** Shared test doubles. No network, no real timers, no randomness. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FetchLike } from '../src/http.js'
import type { WebSocketLike } from '../src/ws/socket.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Load a recorded fixture. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8')) as T
}

/* -------------------------------------------------------------------------- */
/* fetch                                                                      */
/* -------------------------------------------------------------------------- */

export type FakeResponse = {
  status?: number
  body?: unknown
  /** Send the body verbatim as text (no JSON content-type). */
  text?: string
  headers?: Record<string, string>
  /** Reject instead of responding, simulating a socket error or a timeout. */
  throws?: Error
}

export type RecordedCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export class FakeFetch {
  readonly calls: RecordedCall[] = []
  private readonly queue: FakeResponse[] = []
  private fallback: FakeResponse | undefined

  /** Queue one response. Responses are consumed in order. */
  push(...responses: FakeResponse[]): this {
    this.queue.push(...responses)
    return this
  }

  /** Response returned once the queue is empty. */
  always(response: FakeResponse): this {
    this.fallback = response
    return this
  }

  get count(): number {
    return this.calls.length
  }

  last(): RecordedCall | undefined {
    return this.calls[this.calls.length - 1]
  }

  readonly fetch: FetchLike = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    const rawBody = init.body
    this.calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof rawBody === 'string' && rawBody !== '' ? JSON.parse(rawBody) : undefined,
    })

    const spec = this.queue.shift() ?? this.fallback
    if (spec === undefined)
      throw new Error(`FakeFetch: no queued response for ${init.method ?? 'GET'} ${url}`)
    if (spec.throws !== undefined) throw spec.throws

    if (spec.text !== undefined) {
      return new Response(spec.text, {
        status: spec.status ?? 200,
        headers: { 'content-type': 'text/plain', ...spec.headers },
      })
    }
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', ...spec.headers },
    })
  }
}

/* -------------------------------------------------------------------------- */
/* clock                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A manual clock with a timer queue. `advance` fires everything due, in order,
 * so backoff and watchdog behaviour is exercised without waiting.
 */
export class FakeClock {
  private time = 1_000_000
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()

  readonly now = (): number => this.time

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.time + ms, fn })
    return id
  }

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  /** Resolves immediately but still advances the clock — used for rate-limit sleeps. */
  readonly sleep = async (ms: number): Promise<void> => {
    this.advance(ms)
    await Promise.resolve()
  }

  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)
      const next = due[0]
      if (next === undefined) break
      const [id, timer] = next
      this.timers.delete(id)
      this.time = Math.max(this.time, timer.at)
      timer.fn()
    }
    this.time = target
  }

  get pending(): number {
    return this.timers.size
  }
}

/* -------------------------------------------------------------------------- */
/* WebSocket                                                                  */
/* -------------------------------------------------------------------------- */

export class FakeSocket implements WebSocketLike {
  static readonly instances: FakeSocket[] = []

  static reset(): void {
    FakeSocket.instances.length = 0
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
    if (socket === undefined) throw new Error('FakeSocket: none constructed')
    return socket
  }

  readyState = 0
  readonly sent: string[] = []
  closedWith: { code?: number | undefined; reason?: string | undefined } | undefined

  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  /** Frames the client sent, JSON-parsed. */
  get sentJson(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.closedWith = { code, reason }
  }

  /* --- server-side stimuli ------------------------------------------------ */

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  serverSend(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  serverError(error: unknown): void {
    this.onerror?.(error)
  }
}

export const fakeFactory = (url: string): WebSocketLike => new FakeSocket(url)

/** A logger that records instead of printing. */
export function recordingLogger(): {
  logger: { debug: LogRecorder; info: LogRecorder; warn: LogRecorder; error: LogRecorder }
  entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }>
} {
  const entries: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = []
  const make =
    (level: string): LogRecorder =>
    (message, meta) => {
      entries.push(meta === undefined ? { level, message } : { level, message, meta })
    }
  return {
    logger: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') },
    entries,
  }
}

type LogRecorder = (message: string, meta?: Record<string, unknown>) => void

/* -------------------------------------------------------------------------- */
/* Accessors                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read a dynamic key off a record. Exists because TypeScript's
 * `noPropertyAccessFromIndexSignature` requires bracket access while Biome's
 * `useLiteralKeys` forbids a literal bracket key — a variable key satisfies both.
 */
export function at<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record?.[key]
}

/** Read one request header off a recorded call (header names are lower-cased). */
export function headerOf(call: RecordedCall | undefined, name: string): string | undefined {
  return call?.headers[name.toLowerCase()]
}
