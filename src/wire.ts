/**
 * Wire <-> domain translation. The ONLY place `'Buy' | 'Sell'` becomes
 * `"buy" | "sell"` and a signed `qty` string becomes a `Side` plus an unsigned size.
 */

import { InvalidRequestError } from './errors.js'
import { instrumentKey, positionKey } from './instrument.js'
import type { Position, WireSide } from './schemas.js'
import type { ExchangePosition, Side } from './types.js'

/* -------------------------------------------------------------------------- */
/* Side                                                                       */
/* -------------------------------------------------------------------------- */

/** `'Buy'` -> `"buy"`. */
export function toWireSide(side: Side): WireSide {
  return side === 'Buy' ? 'buy' : 'sell'
}

/** `"buy"` -> `'Buy'`. */
export function fromWireSide(side: WireSide): Side {
  return side === 'buy' ? 'Buy' : 'Sell'
}

/** The side that CLOSES a position held in `side`. */
export function closingSide(side: Side): Side {
  return side === 'Buy' ? 'Sell' : 'Buy'
}

/** Position direction from the venue's signed qty: `> 0` long, `< 0` short. */
export function sideFromQty(qty: number | string): Side {
  const n = Number(qty)
  if (!Number.isFinite(n))
    throw new InvalidRequestError(`position qty is not a number: ${String(qty)}`)
  return n >= 0 ? 'Buy' : 'Sell'
}

/* -------------------------------------------------------------------------- */
/* Slippage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Omni slippage fields are FRACTIONS OF 1 (`0.005` = 0.5%), never bps and never
 * percent — including `/orders/close_all`'s misleadingly named
 * `slippage_percent`. The client-side validator accepts `[0, 0.5]`.
 */
export const MAX_SLIPPAGE_FRACTION = 0.5

/** Basis points -> the venue's fraction, clamped into the accepted range. */
export function bpsToFraction(bps: number): number {
  if (!Number.isFinite(bps) || bps < 0)
    throw new InvalidRequestError(`maxSlippageBps must be >= 0, got ${String(bps)}`)
  const fraction = bps / 10_000
  if (fraction > MAX_SLIPPAGE_FRACTION) {
    throw new InvalidRequestError(
      `slippage ${fraction} exceeds the venue maximum ${MAX_SLIPPAGE_FRACTION} (${bps} bps)`,
    )
  }
  // The UI writes at most 4 decimal places (0.01% granularity); match it so we
  // never send a value the venue would round differently.
  return Number(fraction.toFixed(6))
}

/** The venue's fraction -> basis points. */
export function fractionToBps(fraction: number): number {
  return fraction * 10_000
}

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse an Omni RFC3339 stamp to epoch milliseconds.
 *
 * Omni emits nanosecond precision (`...:14.566862123Z`), which `Date.parse`
 * handles by truncating — that is what we want, and it is lossless at the
 * millisecond resolution everything else here works in.
 */
export function parseTimestamp(value: string | null | undefined): number | undefined {
  if (value == null || value === '') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/* -------------------------------------------------------------------------- */
/* Positions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Translate a venue position row into the contract's {@link ExchangePosition}.
 *
 * `fallbackTs` is used when the row carries no `updated_at`; the caller supplies
 * it (usually the receive time) so this function stays clock-free.
 */
export function toExchangePosition(
  position: Position,
  opts: { fallbackTs: number; subAccount?: string },
): ExchangePosition {
  const info = position.position_info
  const signedQty = Number(info.qty)
  if (!Number.isFinite(signedQty)) {
    throw new InvalidRequestError(`position qty is not a number: ${info.qty}`)
  }
  const subAccount = opts.subAccount ?? 'cross'
  const key = instrumentKey(info.instrument)
  const mark = Number(position.price_info.price)
  const liq =
    position.estimated_liquidation_price == null
      ? undefined
      : Number(position.estimated_liquidation_price)

  const out: ExchangePosition = {
    key: positionKey(key, subAccount),
    instrumentId: key,
    subAccount,
    side: sideFromQty(signedQty),
    qty: Math.abs(signedQty),
    entry: Number(info.avg_entry_price),
    updatedAt: parseTimestamp(info.updated_at) ?? opts.fallbackTs,
  }
  if (Number.isFinite(mark)) out.markPrice = mark
  if (liq !== undefined && Number.isFinite(liq)) out.liquidationPrice = liq
  return out
}

/** True when a venue clearing status means the order was rejected. */
export function isRejected(clearingStatus: string | null | undefined): boolean {
  return typeof clearingStatus === 'string' && clearingStatus.startsWith('rejected_')
}

/**
 * Rejects that are expected and benign — a reduce-only order against a position
 * that is already flat, or a cancel that found nothing. A circuit breaker should not
 * count these as failures.
 */
const BENIGN_REJECTS = new Set([
  'rejected_failed_reduce_only_check',
  'rejected_clearing_failed_reduce_only_check',
])

export function isBenignReject(
  clearingStatus: string | null | undefined,
  cancelReason?: string | null,
): boolean {
  if (
    typeof cancelReason === 'string' &&
    (cancelReason === 'no_positions' || cancelReason === 'no_positions_for_side')
  ) {
    return true
  }
  return typeof clearingStatus === 'string' && BENIGN_REJECTS.has(clearingStatus)
}
