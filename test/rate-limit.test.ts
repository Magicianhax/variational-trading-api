import { describe, expect, it } from 'vitest'
import { DEFAULT_RATE_LIMITS, RateLimiter } from '../src/rate-limit.js'
import { FakeClock } from './helpers.js'

function limiter(clock: FakeClock, config = {}): RateLimiter {
  return new RateLimiter(config, { now: clock.now, sleep: clock.sleep })
}

describe('RateLimiter', () => {
  it('spends the burst then blocks until a token refills', async () => {
    const clock = new FakeClock()
    const rl = limiter(clock, { order: { tokens: 6, windowMs: 10_000, burst: 3 } })

    expect(rl.tryAcquire('order')).toBe(true)
    expect(rl.tryAcquire('order')).toBe(true)
    expect(rl.tryAcquire('order')).toBe(true)
    expect(rl.tryAcquire('order')).toBe(false)

    // 6 per 10 s == one token every ~1667 ms.
    expect(rl.waitMs('order')).toBeGreaterThan(1_600)
    expect(rl.waitMs('order')).toBeLessThanOrEqual(1_700)

    await rl.acquire('order')
    expect(clock.now()).toBeGreaterThan(1_000_000)
  })

  it('keeps classes independent so a poll storm cannot starve an emergency close', () => {
    const clock = new FakeClock()
    const rl = limiter(clock)
    for (let i = 0; i < 20; i++) rl.tryAcquire('read')
    expect(rl.tryAcquire('read')).toBe(false)
    expect(rl.tryAcquire('order')).toBe(true)
  })

  it('never refills past the burst capacity', () => {
    const clock = new FakeClock()
    const rl = limiter(clock, { order: { tokens: 6, windowMs: 10_000, burst: 3 } })
    clock.advance(600_000)
    expect(rl.snapshot().order.tokens).toBe(3)
  })

  it('hard-suspends a class after a 418/429, then recovers', async () => {
    const clock = new FakeClock()
    const rl = limiter(clock)
    rl.suspend('order', 30)
    expect(rl.tryAcquire('order')).toBe(false)
    expect(rl.snapshot().order.suspendedForMs).toBeGreaterThan(29_000)

    clock.advance(30_251)
    expect(rl.tryAcquire('order')).toBe(true)
  })

  it('acquire() waits out a suspension rather than failing', async () => {
    const clock = new FakeClock()
    const rl = limiter(clock)
    rl.suspend('quote', 2)
    const before = clock.now()
    await rl.acquire('quote')
    expect(clock.now() - before).toBeGreaterThanOrEqual(2_000)
  })

  it('ships the documented default budgets (docs/ACCESS.md)', () => {
    expect(DEFAULT_RATE_LIMITS.order).toEqual({ tokens: 6, windowMs: 10_000, burst: 3 })
    expect(DEFAULT_RATE_LIMITS.read).toEqual({ tokens: 20, windowMs: 10_000 })
    expect(DEFAULT_RATE_LIMITS.quote).toEqual({ tokens: 30, windowMs: 10_000 })
    expect(DEFAULT_RATE_LIMITS.meta).toEqual({ tokens: 6, windowMs: 60_000 })
  })

  /*
   * Regression: `acquire` waited forever.
   *
   * The wait for a token sat OUTSIDE the request's own timeout -- http.ts awaited
   * acquire() and only then applied AbortSignal.timeout to the fetch. So when the `meta`
   * bucket (6 per 60 s) was oversubscribed, /market-stats blocked indefinitely: an
   * upstream caller gave up at 8 s, but the request stayed queued and still spent a
   * token when one arrived. Every abandoned caller starved a live one.
   *
   * A caller that has given up must stop holding a place in the queue.
   */
  it('gives up waiting once its deadline passes, instead of queueing forever', async () => {
    const clock = new FakeClock()
    const rl = limiter(clock, { meta: { tokens: 6, windowMs: 60_000 } })
    for (let i = 0; i < 6; i++) expect(rl.tryAcquire('meta')).toBe(true)

    // A token is 10 s away, but this caller only has 8 s -- the proxy's timeout.
    await expect(rl.acquire('meta', { timeoutMs: 8_000 })).rejects.toThrow(/rate limit/i)
  })

  it('does not spend a token it waited for but never received', async () => {
    const clock = new FakeClock()
    const rl = limiter(clock, { meta: { tokens: 6, windowMs: 60_000 } })
    for (let i = 0; i < 6; i++) rl.tryAcquire('meta')

    await expect(rl.acquire('meta', { timeoutMs: 8_000 })).rejects.toThrow()
    // The abandoned waiter must not have consumed the refill: a caller arriving after
    // the token lands still gets it.
    await rl.acquire('meta', { timeoutMs: 60_000 })
    expect(rl.snapshot().meta.tokens).toBe(0)
  })

  it('still waits without a deadline, so existing callers are unchanged', async () => {
    const clock = new FakeClock()
    const rl = limiter(clock, { meta: { tokens: 1, windowMs: 10_000 } })
    expect(rl.tryAcquire('meta')).toBe(true)
    await rl.acquire('meta')
    expect(clock.now()).toBeGreaterThan(1_000_000)
  })

  it('aborts immediately when the caller signals it has gone away', async () => {
    const clock = new FakeClock()
    const rl = limiter(clock, { meta: { tokens: 1, windowMs: 60_000 } })
    expect(rl.tryAcquire('meta')).toBe(true)
    const ac = new AbortController()
    ac.abort()
    await expect(rl.acquire('meta', { signal: ac.signal })).rejects.toThrow(/abort/i)
  })
})
