import { describe, expect, it } from 'vitest'
import { InvalidRequestError } from '../src/errors.js'
import {
  asInstrumentKey,
  assetQuery,
  instrumentDisplay,
  instrumentKey,
  instrumentObject,
  instrumentQuery,
  parseInstrumentKey,
  positionKey,
  splitPositionKey,
} from '../src/instrument.js'
import { supportedAssetsSchema } from '../src/schemas.js'
import { at, fixture } from './helpers.js'

const assets = supportedAssetsSchema.parse(fixture('supported-assets.json'))
const btcRow = at(assets, 'BTC')?.[0]
const shazRow = at(assets, 'SHAZ')?.[0]
if (btcRow === undefined || shazRow === undefined) throw new Error('fixture missing BTC/SHAZ')

describe('instrumentObject', () => {
  it('builds the perpetual-future form with funding_interval_s pinned to 3600', () => {
    // The asset row itself says 28800 — that is the PAYMENT interval and must
    // never reach the wire; the contract interval is always 3600.
    expect(btcRow.funding_interval_s).toBe(28800)
    expect(instrumentObject(btcRow)).toEqual({
      underlying: 'BTC',
      instrument_type: 'perpetual_future',
      settlement_asset: 'USDC',
      funding_interval_s: 3600,
    })
  })

  it('omits funding_interval_s and adds kind for RWA', () => {
    expect(instrumentObject(shazRow)).toEqual({
      underlying: 'SHAZ',
      instrument_type: 'perpetual_rwa_future',
      settlement_asset: 'USDC',
      kind: 'equity',
    })
  })

  it('keeps both kind and funding_interval_s for a CFD', () => {
    expect(
      instrumentObject({
        symbol: 'XAU',
        instrument_type: 'perpetual_cfd',
        asset_class: 'commodity',
      }),
    ).toEqual({
      underlying: 'XAU',
      instrument_type: 'perpetual_cfd',
      settlement_asset: 'USDC',
      kind: 'commodity',
      funding_interval_s: 3600,
    })
  })

  it('carries dex_token_details for a DEX listing', () => {
    const built = instrumentObject({
      symbol: 'WIF',
      dex_token_details: { network: 'base', underlying_address: '0xabc' },
    })
    expect(built).toEqual({
      underlying: 'WIF',
      instrument_type: 'perpetual_future',
      settlement_asset: 'USDC',
      funding_interval_s: 3600,
      dex_token_details: { network: 'base', underlying_address: '0xabc' },
    })
  })

  it('round-trips an instrument that came off the wire', () => {
    const fromWire = { underlying: 'ETH', instrument_type: 'perpetual_future' as const }
    expect(instrumentObject(fromWire).underlying).toBe('ETH')
  })

  it('refuses an RWA with no asset class rather than guessing', () => {
    expect(() =>
      instrumentObject({ symbol: 'SHAZ', instrument_type: 'perpetual_rwa_future' }),
    ).toThrow(InvalidRequestError)
  })
})

describe('instrumentKey', () => {
  it('builds the four key shapes', () => {
    expect(instrumentKey(btcRow)).toBe('P-BTC-USDC-3600')
    expect(instrumentKey(shazRow)).toBe('P-RWA/EQY-SHAZ-USDC')
    expect(
      instrumentKey({ symbol: 'XAU', instrument_type: 'perpetual_cfd', asset_class: 'commodity' }),
    ).toBe('P-XAU-USDC-3600')
    expect(
      instrumentKey({
        symbol: 'WIF',
        dex_token_details: { network: 'base', underlying_address: '0xabc' },
      }),
    ).toBe('P-base_0xabc-WIF-USDC-3600')
  })

  it('accepts both a listing (symbol) and a wire instrument (underlying)', () => {
    expect(instrumentKey({ underlying: 'BTC', instrument_type: 'perpetual_future' })).toBe(
      'P-BTC-USDC-3600',
    )
  })
})

describe('parseInstrumentKey', () => {
  it('inverts every key shape, and tolerates the WS channel prefix', () => {
    expect(parseInstrumentKey('P-BTC-USDC-3600')).toEqual({
      symbol: 'BTC',
      instrument_type: 'perpetual_future',
    })
    expect(parseInstrumentKey('instrument_price:P-BTC-USDC-3600')).toEqual({
      symbol: 'BTC',
      instrument_type: 'perpetual_future',
    })
    expect(parseInstrumentKey('P-RWA/EQY-SHAZ-USDC')).toEqual({
      symbol: 'SHAZ',
      instrument_type: 'perpetual_rwa_future',
      asset_class: 'equity',
    })
    expect(parseInstrumentKey('P-base_0xabc-WIF-USDC-3600')).toEqual({
      symbol: 'WIF',
      instrument_type: 'perpetual_future',
      dex_token_details: { network: 'base', underlying_address: '0xabc' },
    })
  })

  it('round-trips through the object builder', () => {
    for (const key of ['P-BTC-USDC-3600', 'P-RWA/EQY-SHAZ-USDC', 'P-base_0xabc-WIF-USDC-3600']) {
      expect(instrumentKey(instrumentObject(parseInstrumentKey(key)))).toBe(key)
    }
  })

  it('rejects a non-key string instead of silently returning nonsense', () => {
    expect(() => asInstrumentKey('BTC')).toThrow(InvalidRequestError)
    expect(() => parseInstrumentKey('nope')).toThrow(InvalidRequestError)
  })
})

describe('query encodings', () => {
  it('flattens for /metadata/v2/*, including asset_class for RWA', () => {
    expect(instrumentQuery(btcRow)).toEqual({
      underlying: 'BTC',
      instrument_type: 'perpetual_future',
    })
    expect(instrumentQuery(shazRow)).toEqual({
      underlying: 'SHAZ',
      instrument_type: 'perpetual_rwa_future',
      asset_class: 'equity',
    })
    expect(
      instrumentQuery({
        symbol: 'WIF',
        dex_token_details: { network: 'base', underlying_address: '0xabc' },
      }),
    ).toEqual({
      underlying: 'WIF',
      instrument_type: 'perpetual_future',
      network: 'base',
      underlying_address: '0xabc',
    })
  })

  it('builds the cex_asset form', () => {
    expect(assetQuery(btcRow)).toEqual({ cex_asset: 'BTC' })
    expect(
      assetQuery({
        symbol: 'WIF',
        dex_token_details: { network: 'base', underlying_address: '0xabc' },
      }),
    ).toEqual({
      network: 'base',
      underlying_address: '0xabc',
    })
  })
})

describe('display + position keys', () => {
  it('renders the ticker', () => {
    expect(instrumentDisplay(btcRow)).toBe('BTC-PERP')
    expect(instrumentDisplay(shazRow)).toBe('SHAZ-PERP')
  })

  it('bridges to the contract PositionKey and back', () => {
    const key = positionKey(btcRow)
    expect(key).toBe('P-BTC-USDC-3600:cross')
    expect(splitPositionKey(key)).toEqual({ instrumentKey: 'P-BTC-USDC-3600', subAccount: 'cross' })
    expect(splitPositionKey(positionKey(btcRow, 'iso-1')).subAccount).toBe('iso-1')
  })
})
