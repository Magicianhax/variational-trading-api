/**
 * Token-bucket rate limiter, shared across one {@link OmniClient} instance.
 *
 * The venue publishes no `/api` limits, so the budgets below are our own
 * conservative policy. They are per endpoint CLASS: a burst of
 * position polls must never eat the budget an emergency close needs.
 *
 * A 418 ("temporarily banned from orders") or 429 carries
 * `{ wait_until_seconds: N }`; the transport calls {@link RateLimiter.suspend}
 * with that value and the whole class is hard-stopped for the duration.
 *
 * Time and sleeping are injected so the whole thing is testable without timers.
 */

/** Endpoint classes with independent budgets. */
export type RateClass = 'order' | 'read' | 'quote' | 'meta' | 'auth'

export type BucketConfig = {
  /** Sustained allowance: `tokens` requests per `windowMs`. */
  tokens: number
  windowMs: number
  /** Burst capacity. Defaults to `tokens`. */
  burst?: number
}

export type RateLimiterConfig = Partial<Record<RateClass, BucketConfig>>

/**
 * Conservative defaults, chosen so a burst of polling can never starve an emergency
 * close: the venue publishes no limits. `order` is deliberately the tightest budget
 * and the only one with a burst smaller than its sustained rate.
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RateClass, BucketConfig>> = {
  order: { tokens: 6, windowMs: 10_000, burst: 3 },
  read: { tokens: 20, windowMs: 10_000 },
  quote: { tokens: 30, windowMs: 10_000 },
  meta: { tokens: 6, windowMs: 60_000 },
  auth: { tokens: 6, windowMs: 60_000 },
}

export type RateLimiterDeps = {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export type BucketSnapshot = {
  tokens: number
  capacity: number
  suspendedForMs: number
}

/** One refilling bucket. Not exported as public API; use {@link RateLimiter}. */
class TokenBucket {
  private readonly capacity: number
  private readonly refillPerMs: number
  private available: number
  private lastRefill: number
  private suspendedUntil = 0

  constructor(
    config: BucketConfig,
    private readonly now: () => number,
  ) {
    this.capacity = Math.max(1, config.burst ?? config.tokens)
    this.refillPerMs = config.tokens / config.windowMs
    this.available = this.capacity
    this.lastRefill = now()
  }

  private refill(): void {
    const t = this.now()
    const elapsed = t - this.lastRefill
    if (elapsed > 0) {
      this.available = Math.min(this.capacity, this.available + elapsed * this.refillPerMs)
      this.lastRefill = t
    }
  }

  /** Milliseconds until one token is available (0 when it already is). */
  waitMs(): number {
    this.refill()
    const suspension = Math.max(0, this.suspendedUntil - this.now())
    if (this.available >= 1) return suspension
    const deficit = 1 - this.available
    return Math.max(suspension, Math.ceil(deficit / this.refillPerMs))
  }

  /** Consume one token if one is free. Returns false when it must wait. */
  tryTake(): boolean {
    this.refill()
    if (this.now() < this.suspendedUntil) return false
    if (this.available < 1) return false
    this.available -= 1
    return true
  }

  suspendFor(ms: number): void {
    this.suspendedUntil = Math.max(this.suspendedUntil, this.now() + ms)
  }

  snapshot(): BucketSnapshot {
    this.refill()
    return {
      tokens: Math.floor(this.available),
      capacity: this.capacity,
      suspendedForMs: Math.max(0, this.suspendedUntil - this.now()),
    }
  }
}

export type AcquireOptions = {
  /** Abort the wait when the caller goes away. */
  signal?: AbortSignal | undefined
  /** Give up if a token cannot arrive within this many milliseconds. */
  timeoutMs?: number | undefined
}

/** A token could not arrive before the caller's deadline. */
export class RateLimitTimeoutError extends Error {
  override readonly name = 'RateLimitTimeoutError'
  constructor(
    readonly rateClass: RateClass,
    readonly waitMs: number,
    readonly timeoutMs: number,
  ) {
    super(
      `rate limit: a '${rateClass}' token is ${waitMs} ms away but the caller allows ${timeoutMs} ms`,
    )
  }
}

/** The caller aborted while queued for a token. */
export class RateLimitAbortError extends Error {
  override readonly name = 'RateLimitAbortError'
  constructor(readonly rateClass: RateClass) {
    super(`rate limit: wait for a '${rateClass}' token was aborted by the caller`)
  }
}

export class RateLimiter {
  private readonly buckets: Map<RateClass, TokenBucket>
  private readonly deps: RateLimiterDeps

  constructor(config: RateLimiterConfig = {}, deps?: Partial<RateLimiterDeps>) {
    this.deps = {
      now: deps?.now ?? (() => Date.now()),
      sleep: deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    }
    this.buckets = new Map()
    for (const cls of Object.keys(DEFAULT_RATE_LIMITS) as RateClass[]) {
      const merged = { ...DEFAULT_RATE_LIMITS[cls], ...config[cls] }
      this.buckets.set(cls, new TokenBucket(merged, this.deps.now))
    }
  }

  private bucket(cls: RateClass): TokenBucket {
    const b = this.buckets.get(cls)
    // Every RateClass is seeded in the constructor, so this cannot be missing;
    // the branch keeps `noUncheckedIndexedAccess` honest without a cast.
    if (b === undefined) throw new Error(`unknown rate class ${cls}`)
    return b
  }

  /**
   * Block until one token of `cls` is available. Waits in slices so a
   * suspension applied while we are queued is respected immediately.
   *
   * Pass a deadline whenever the caller has one of its own. The wait for a token is
   * time the request is spending just like time on the wire, and a caller that has
   * already given up must stop holding a place in the queue -- otherwise it still
   * spends a token when one arrives, producing a response nobody is waiting for while
   * starving a caller who is. That is exactly how /market-stats wedged: the terminal
   * polled every 30 s against a 6-per-60 s budget, the proxy timed out at 8 s, and the
   * abandoned waiters kept the bucket permanently oversubscribed.
   */
  async acquire(cls: RateClass, opts: AcquireOptions = {}): Promise<void> {
    const { signal, timeoutMs } = opts
    const deadline = timeoutMs === undefined ? null : this.deps.now() + timeoutMs
    for (;;) {
      if (signal?.aborted === true) throw new RateLimitAbortError(cls)
      const bucket = this.bucket(cls)
      if (bucket.tryTake()) return
      const wait = Math.max(1, bucket.waitMs())
      if (deadline !== null) {
        const left = deadline - this.deps.now()
        // Refusing here rather than sleeping and re-checking keeps the failure honest:
        // we know now that the token cannot arrive in time.
        if (left <= 0 || wait > left) throw new RateLimitTimeoutError(cls, wait, timeoutMs ?? 0)
      }
      await this.deps.sleep(wait)
    }
  }

  /** Non-blocking variant, for callers that would rather fail fast. */
  tryAcquire(cls: RateClass): boolean {
    return this.bucket(cls).tryTake()
  }

  /** Hard-stop a class for `seconds` (plus jitter) after a 418/429. */
  suspend(cls: RateClass, seconds: number, jitterMs = 250): void {
    this.bucket(cls).suspendFor(Math.max(0, seconds) * 1000 + jitterMs)
  }

  /** Milliseconds a caller would currently have to wait for `cls`. */
  waitMs(cls: RateClass): number {
    return this.bucket(cls).waitMs()
  }

  snapshot(): Record<RateClass, BucketSnapshot> {
    const out = {} as Record<RateClass, BucketSnapshot>
    for (const [cls, bucket] of this.buckets) out[cls] = bucket.snapshot()
    return out
  }
}
