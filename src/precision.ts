/**
 * Quantity and price formatting for the Omni wire.
 *
 * The reference bundle contains TWO mutually inconsistent quantity rules:
 *
 *  - `Ll`/`Xt` (order form) counts the decimals of `min_qty_tick` **verbatim**,
 *    so `"0.00100"` yields 5.
 *  - `c4` (the pre-flight validity check) strips trailing zeros **first**, so
 *    the same tick yields 3 — and it rejects any qty with more decimals.
 *
 * We use the stripped count, because it is the stricter of the two and a value
 * that satisfies it also satisfies the other. Truncation (never rounding) is
 * used for quantities: rounding a reduce-only close *up* can exceed the
 * position and turn a close into an open.
 *
 * All functions here are pure and operate on decimal strings, so a 17-digit
 * float never silently eats a satoshi.
 */

import { InvalidRequestError } from './errors.js'

/**
 * Decimals we will emit for a price, counted from its first significant digit.
 *
 * Guards float artefacts like `61234.500000000004`. It was a fixed clamp on total
 * decimals, which is fine above a cent and wrong below it: a memecoin at 1.23e-7 became
 * `0.00000012` (2.4% off), and 4.9e-9 became `0` — a stop that would never trigger.
 * The venue lists DEX markets priced that low; the clamp now follows the magnitude.
 */
export const MAX_PRICE_DECIMALS = 8
/** Hard ceiling on emitted decimals, whatever the magnitude. */
const MAX_TOTAL_DECIMALS = 18

/**
 * Render a number or numeric string as a plain (non-exponential) decimal string.
 * `1e-7` becomes `"0.0000001"`, `1.5e21` becomes `"1500000000000000000000"`.
 */
export function toPlainString(value: number | string): string {
  const raw = typeof value === 'string' ? value.trim().replace(/[,_\s]/g, '') : String(value)
  if (raw === '') return ''
  if (!/[eE]/.test(raw)) return raw

  const m = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(raw)
  if (m === null) return raw

  const sign = m[1] ?? ''
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? ''
  const exp = Number(m[4])
  const digits = `${intPart}${fracPart}`
  const point = intPart.length + exp

  let body: string
  if (point <= 0) body = `0.${'0'.repeat(-point)}${digits}`
  else if (point >= digits.length) body = digits + '0'.repeat(point - digits.length)
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`

  return `${sign}${body}`
}

/** `"1.2300"` -> `"1.23"`, `"1.000"` -> `"1"`, `"100"` -> `"100"`. Never touches the integer part. */
export function stripTrailingZeros(value: string): string {
  if (!value.includes('.')) return value
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '' || trimmed === '-' ? '0' : trimmed
}

/** Number of digits after the decimal point, verbatim (no zero-stripping). */
export function countDecimals(value: number | string): number {
  const s = toPlainString(value)
  const i = s.indexOf('.')
  return i === -1 ? 0 : s.length - i - 1
}

/**
 * Decimals a quantity may carry for an instrument, derived from `min_qty_tick`.
 * Trailing zeros are stripped first — see the module note.
 */
export function qtyDecimalsFromTick(minQtyTick: number | string): number {
  return countDecimals(stripTrailingZeros(toPlainString(minQtyTick)))
}

/**
 * Truncate toward zero to `decimals` places, string-wise (this is exactly what
 * the bundle's `so` does, minus its lossy `+` coercion).
 */
export function truncateToDecimals(value: number | string, decimals: number): string {
  const s = toPlainString(value)
  if (s === '') return s
  const dot = s.indexOf('.')
  if (dot === -1) return s
  if (decimals <= 0) return s.slice(0, dot)
  const cut = s.slice(0, dot + 1 + decimals)
  return cut.endsWith('.') ? cut.slice(0, -1) : cut
}

/**
 * Format a quantity for the wire: truncate to the instrument's tick precision,
 * then strip trailing zeros so `c4`'s decimal check also passes.
 *
 * Throws {@link InvalidRequestError} for non-finite or negative input — the API
 * only ever receives unsigned quantities (direction lives in `side`).
 */
export function formatQty(qty: number | string, minQtyTick: number | string): string {
  const n = Number(qty)
  if (!Number.isFinite(n))
    throw new InvalidRequestError(`qty is not a finite number: ${String(qty)}`)
  if (n < 0) throw new InvalidRequestError(`qty must be unsigned, got ${String(qty)}`)
  return stripTrailingZeros(truncateToDecimals(qty, qtyDecimalsFromTick(minQtyTick)))
}

/**
 * Format a price for the wire. The reference client applies no tick rounding at
 * all (`Number.prototype.toString()`), so neither do we; we only clamp the
 * decimal count to kill binary-float artefacts.
 */
export function formatPrice(
  price: number | string,
  maxDecimals: number = MAX_PRICE_DECIMALS,
): string {
  const n = Number(price)
  if (!Number.isFinite(n))
    throw new InvalidRequestError(`price is not a finite number: ${String(price)}`)
  if (n === 0) return '0'
  const abs = Math.abs(n)
  // Leading zeros after the point do not count against the budget.
  const lead = abs < 1 ? Math.max(0, Math.floor(-Math.log10(abs))) : 0
  const decimals = Math.min(MAX_TOTAL_DECIMALS, maxDecimals + lead)
  // toFixed is exact enough below 1e21 and rounds half-away-from-zero, which is
  // what we want for a display-precision clamp.
  const fixed = abs < 1e21 ? n.toFixed(decimals) : toPlainString(n)
  return stripTrailingZeros(fixed)
}

/** One side of a quote's `qty_limits` block. */
export type QtyLimit = {
  min_qty: string
  max_qty: string
  min_qty_tick: string
}

export type QtyValidation = { ok: true } | { ok: false; reason: string }

/**
 * Pre-flight check mirroring the bundle's `c4`: bounds plus decimal count.
 * Run this before every order — a rejected order costs a round trip and, on
 * `/orders/new/*`, counts against the order rate budget.
 */
export function validateQty(qty: number | string, limit: QtyLimit): QtyValidation {
  const s = toPlainString(qty)
  const n = Number(s)
  if (!Number.isFinite(n))
    return { ok: false, reason: `qty "${String(qty)}" is not a finite number` }
  if (n <= 0) return { ok: false, reason: `qty ${s} must be > 0` }

  const min = Number(limit.min_qty)
  const max = Number(limit.max_qty)
  if (Number.isFinite(min) && n < min)
    return { ok: false, reason: `qty ${s} below min_qty ${limit.min_qty}` }
  if (Number.isFinite(max) && max > 0 && n > max) {
    return { ok: false, reason: `qty ${s} above max_qty ${limit.max_qty}` }
  }

  const allowed = qtyDecimalsFromTick(limit.min_qty_tick)
  const have = countDecimals(stripTrailingZeros(s))
  if (have > allowed) {
    return { ok: false, reason: `qty ${s} has ${have} decimals, min_qty_tick allows ${allowed}` }
  }
  return { ok: true }
}

/**
 * Notional check against `/metadata/config.min_order_notional` (0.1 USDC live).
 * Cheap to run and it catches the most common 422 before it is sent.
 */
export function meetsMinNotional(
  qty: number | string,
  price: number | string,
  minOrderNotional: number | string,
): boolean {
  const notional = Number(qty) * Number(price)
  const min = Number(minOrderNotional)
  if (!Number.isFinite(notional) || !Number.isFinite(min)) return false
  return notional >= min
}
