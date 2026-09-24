/**
 * Instrument encoding. Omni uses TWO incompatible encodings and mixing them
 * fails SILENTLY (`?instrument=<object>` returns everything or nothing), so
 * both are branded and the type system refuses to swap them.
 *
 *  - OBJECT form  -> POST bodies, `position_info.instrument`, WS subscribe frames
 *  - KEY-STRING   -> `?instrument=` query param, WS channel suffix, map keys
 *
 * `funding_interval_s` is ALWAYS pinned to 3600 in the object form, even when
 * the market's real funding interval is different (BTC pays every 8 h but is
 * still `...-3600`). Subscribing with the real interval is rejected by the
 * price feed and kills the socket. The real interval lives on the asset row and
 * on `/funding/v2`, and must never be copied into an instrument object.
 */

import { InvalidRequestError } from './errors.js'
import type {
  AssetClass,
  DexTokenDetails,
  InstrumentType,
  InstrumentWire,
  SupportedAsset,
} from './schemas.js'

declare const brandSymbol: unique symbol

/** Nominal typing helper. The brand exists only at the type level. */
type Brand<T, B extends string> = T & { readonly [brandSymbol]: B }

/** The instrument object as it appears in POST bodies and WS subscribe frames. */
export type InstrumentObject = Brand<InstrumentWire, 'InstrumentObject'>

/** The instrument key string, e.g. `P-BTC-USDC-3600` or `P-RWA/EQY-SHAZ-USDC`. */
export type InstrumentKey = Brand<string, 'InstrumentKey'>

/** Pinned in every instrument object. See the module note. */
export const CONTRACT_FUNDING_INTERVAL_S = 3600

/** The only settlement asset Omni quotes today. */
export const SETTLEMENT_ASSET = 'USDC'

/** `asset_class` -> the three-letter tag used inside an RWA key string. */
const RWA_TAG: Readonly<Record<AssetClass, string>> = {
  equity: 'EQY',
  commodity: 'CMD',
  index: 'IDX',
  etf: 'ETF',
}

const RWA_TAG_INVERSE: Readonly<Record<string, AssetClass>> = {
  EQY: 'equity',
  CMD: 'commodity',
  IDX: 'index',
  ETF: 'etf',
}

/**
 * Anything that names an instrument: a `/metadata/supported_assets` row (symbol
 * in `asset`), the bundle's internal listing shape (symbol in `symbol`), or an
 * instrument object already off the wire (symbol in `underlying`).
 */
export type AssetLike = {
  asset?: string | undefined
  symbol?: string | undefined
  underlying?: string | undefined
  instrument_type?: InstrumentType | null | undefined
  asset_class?: AssetClass | null | undefined
  kind?: AssetClass | null | undefined
  dex_token_details?: DexTokenDetails | null | undefined
}

export type InstrumentInput = AssetLike | SupportedAsset | InstrumentWire

type Normalised = {
  symbol: string
  instrumentType: InstrumentType
  assetClass: AssetClass | undefined
  dex: DexTokenDetails | undefined
}

function normalise(input: InstrumentInput): Normalised {
  const a = input as AssetLike
  const symbol = a.symbol ?? a.asset ?? a.underlying
  if (symbol === undefined || symbol === '') {
    throw new InvalidRequestError('instrument input has no symbol/asset/underlying')
  }
  const instrumentType: InstrumentType = a.instrument_type ?? 'perpetual_future'
  const assetClass = a.kind ?? a.asset_class ?? undefined
  const dex = a.dex_token_details ?? undefined
  return { symbol, instrumentType, assetClass, dex }
}

/**
 * Build the OBJECT form. Mirrors the bundle's `$o` exactly, including which
 * branches carry `funding_interval_s` and which carry `kind`.
 *
 * Accepts an asset row, the bundle's listing shape, or an instrument already
 * off the wire — so a `position_info.instrument` can be round-tripped straight
 * back into an order body.
 */
export function instrumentObject(input: InstrumentInput): InstrumentObject {
  const { symbol, instrumentType, assetClass, dex } = normalise(input)

  switch (instrumentType) {
    case 'perpetual_rwa_future': {
      if (assetClass === undefined) {
        throw new InvalidRequestError(
          `asset ${symbol} is perpetual_rwa_future but has no asset_class`,
        )
      }
      // RWA deliberately omits funding_interval_s.
      return {
        underlying: symbol,
        instrument_type: 'perpetual_rwa_future',
        settlement_asset: SETTLEMENT_ASSET,
        kind: assetClass,
      } as InstrumentObject
    }
    case 'perpetual_cfd': {
      if (assetClass === undefined) {
        throw new InvalidRequestError(`asset ${symbol} is perpetual_cfd but has no asset_class`)
      }
      return {
        underlying: symbol,
        instrument_type: 'perpetual_cfd',
        settlement_asset: SETTLEMENT_ASSET,
        kind: assetClass,
        funding_interval_s: CONTRACT_FUNDING_INTERVAL_S,
      } as InstrumentObject
    }
    default: {
      // Everything else (including dated futures / options passed in by
      // mistake) collapses to the perpetual-future branch, exactly as `$o` does.
      const base: InstrumentWire = {
        underlying: symbol,
        instrument_type: 'perpetual_future',
        settlement_asset: SETTLEMENT_ASSET,
        funding_interval_s: CONTRACT_FUNDING_INTERVAL_S,
      }
      // `undefined` is dropped by JSON.stringify, but we omit the key outright
      // so deep-equality against a captured fixture succeeds.
      return (dex === undefined ? base : { ...base, dex_token_details: dex }) as InstrumentObject
    }
  }
}

/**
 * Build the KEY-STRING form. Mirrors the bundle's `ht`.
 *
 * `P-BTC-USDC-3600`, `P-base_0xabc…-WIF-USDC-3600`, `P-RWA/EQY-SHAZ-USDC`.
 * Note a CFD keys the same way an ordinary perp does.
 */
export function instrumentKey(input: InstrumentInput): InstrumentKey {
  const { symbol, instrumentType, assetClass, dex } = normalise(input)

  if (instrumentType === 'perpetual_rwa_future') {
    const tag = assetClass === undefined ? '' : RWA_TAG[assetClass]
    if (tag === '')
      throw new InvalidRequestError(
        `RWA instrument ${symbol} has no asset_class; key is unresolvable`,
      )
    return `P-RWA/${tag}-${symbol}-${SETTLEMENT_ASSET}` as InstrumentKey
  }

  const parts = ['P']
  if (dex !== undefined) parts.push(`${dex.network}_${dex.underlying_address}`)
  parts.push(symbol, SETTLEMENT_ASSET, String(CONTRACT_FUNDING_INTERVAL_S))
  return parts.join('-') as InstrumentKey
}

/** Assert an untrusted string is a plausible instrument key and brand it. */
export function asInstrumentKey(raw: string): InstrumentKey {
  const key = raw.startsWith('instrument_price:') ? raw.slice('instrument_price:'.length) : raw
  if (!key.startsWith('P-')) throw new InvalidRequestError(`not an instrument key: ${raw}`)
  return key as InstrumentKey
}

/**
 * Inverse of {@link instrumentKey}. Mirrors the bundle's `Go`, including its
 * tolerance of a leading `instrument_price:` channel prefix.
 *
 * Returns an {@link AssetLike} which can be fed straight back to
 * {@link instrumentObject}.
 */
export function parseInstrumentKey(raw: string): AssetLike {
  const key = raw.startsWith('instrument_price:') ? raw.slice('instrument_price:'.length) : raw
  const parts = key.split('-')
  const second = parts[1]
  if (second === undefined) throw new InvalidRequestError(`not an instrument key: ${raw}`)

  if (second.startsWith('RWA/')) {
    const symbol = parts[2]
    if (symbol === undefined) throw new InvalidRequestError(`malformed RWA instrument key: ${raw}`)
    const tag = second.slice('RWA/'.length).toUpperCase()
    const assetClass = RWA_TAG_INVERSE[tag]
    if (assetClass === undefined)
      throw new InvalidRequestError(`unknown RWA asset class tag "${tag}" in ${raw}`)
    return { symbol, instrument_type: 'perpetual_rwa_future', asset_class: assetClass }
  }

  const underscore = second.indexOf('_')
  if (underscore > 0) {
    const network = second.slice(0, underscore)
    const address = second.slice(underscore + 1)
    const symbol = parts[2]
    if (symbol === undefined) throw new InvalidRequestError(`malformed DEX instrument key: ${raw}`)
    return {
      symbol,
      instrument_type: 'perpetual_future',
      dex_token_details: { network, underlying_address: address },
    }
  }

  return { symbol: second, instrument_type: 'perpetual_future' }
}

/** Display ticker, mirroring the bundle's `Fe`: `BTC-PERP`. */
export function instrumentDisplay(input: InstrumentInput): string {
  const { symbol, instrumentType } = normalise(input)
  switch (instrumentType) {
    case 'perpetual_future':
    case 'perpetual_rwa_future':
    case 'perpetual_cfd':
      return `${symbol}-PERP`
    default:
      return `${symbol}-UNKNOWN`
  }
}

/**
 * The FLATTENED query form used by `/metadata/v2/risk_limits`,
 * `/metadata/v2/open_interest` and `/funding/v2` (the bundle's `Ho`).
 *
 * Serde rejects it field by field, so `underlying` and `instrument_type` are
 * mandatory; `asset_class` is required for RWA and `network`/`underlying_address`
 * for DEX listings.
 */
export function instrumentQuery(input: InstrumentInput): Record<string, string> {
  const { symbol, instrumentType, assetClass, dex } = normalise(input)
  return {
    underlying: symbol,
    instrument_type: instrumentType,
    ...(assetClass === undefined ? {} : { asset_class: assetClass }),
    ...(dex === undefined
      ? {}
      : { network: dex.network, underlying_address: dex.underlying_address }),
  }
}

/**
 * The `cex_asset` / `network`+`underlying_address` query form (the bundle's
 * `Yo`), used by a handful of asset-scoped metadata routes.
 */
export function assetQuery(input: InstrumentInput): Record<string, string> {
  const { symbol, dex } = normalise(input)
  if (dex !== undefined) return { network: dex.network, underlying_address: dex.underlying_address }
  return { cex_asset: symbol }
}

/**
 * Build a {@link PositionKey} (`` `${instrumentId}:${subAccount}` ``).
 *
 * The venue itself has no sub-account dimension on a position — one position per
 * instrument, period — so `subAccount` defaults to `cross`. The isolated/cross
 * distinction is derived from `portfolio.sub_accounts.isolated`, and switching
 * modes never changes a position's identity.
 */
export function positionKey(input: InstrumentInput | InstrumentKey, subAccount = 'cross'): string {
  const key = typeof input === 'string' ? asInstrumentKey(input) : instrumentKey(input)
  return `${key}:${subAccount}`
}

/** Split a `PositionKey` back into its instrument key and sub-account. */
export function splitPositionKey(key: string): {
  instrumentKey: InstrumentKey
  subAccount: string
} {
  const idx = key.lastIndexOf(':')
  if (idx === -1) return { instrumentKey: asInstrumentKey(key), subAccount: 'cross' }
  return {
    instrumentKey: asInstrumentKey(key.slice(0, idx)),
    subAccount: key.slice(idx + 1),
  }
}
