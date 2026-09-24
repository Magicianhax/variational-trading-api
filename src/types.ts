/**
 * Domain vocabulary at the client's edges.
 *
 * Wire strings are parsed into these at the boundary (see `wire.ts`), so code built on
 * this client works with numbers and a two-valued `Side`, never with the API's decimal
 * strings and lower-case spellings.
 */

/** Variational's own side enum, spelled exactly as the API spells it on positions. */
export type Side = 'Buy' | 'Sell'

/** Instrument identifier as reported by the exchange. */
export type InstrumentId = string

/** Sub-account / settlement-pool identifier as reported by the exchange. */
export type SubAccount = string

/**
 * Canonical identity of a position: `` `${instrumentId}:${subAccount}` ``.
 * Build it once, at the edge, and pass it around verbatim — re-deriving it ad hoc is
 * how one position quietly becomes two.
 */
export type PositionKey = string

/** Milliseconds since the Unix epoch, UTC. */
export type Timestamp = number

/** A price in the instrument's quote currency (USDC on Omni). */
export type Price = number

/** An absolute, unsigned position size. Direction lives in {@link Side}. */
export type Qty = number

/** One mark-price observation for one position. */
export type MarkTick = {
  key: PositionKey
  price: Price
  /**
   * The VENUE's timestamp for this price: when it was computed, not when it arrived.
   * On Variational this trails arrival by a variable amount, so it is the market's time
   * axis — not a measure of feed health. Measure staleness on {@link recvTs}.
   */
  ts: Timestamp
  /**
   * When the tick was received, stamped at the transport boundary. Measured on the live
   * socket, arrivals never gapped past ~1.3 s while consecutive venue stamps reached
   * ~3.5 s — so "the feed went quiet" is a question about this field, not {@link ts}.
   */
  recvTs?: Timestamp
}

/** A position as the exchange currently reports it. */
export type ExchangePosition = {
  key: PositionKey
  instrumentId: InstrumentId
  subAccount: SubAccount
  /** Direction of the OPEN position. Closing it requires the opposite side. */
  side: Side
  /** Absolute remaining size. Always > 0 for a live position. */
  qty: Qty
  /** Volume-weighted average entry price. */
  entry: Price
  markPrice?: Price
  liquidationPrice?: Price
  /** Exchange timestamp for this snapshot. */
  updatedAt: Timestamp
}
