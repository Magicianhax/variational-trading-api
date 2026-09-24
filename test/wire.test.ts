import { describe, expect, it } from 'vitest'
import { InvalidRequestError } from '../src/errors.js'
import { positionsSchema } from '../src/schemas.js'
import {
  bpsToFraction,
  closingSide,
  fractionToBps,
  fromWireSide,
  isBenignReject,
  isRejected,
  parseTimestamp,
  sideFromQty,
  toExchangePosition,
  toWireSide,
} from '../src/wire.js'
import { fixture } from './helpers.js'

const positions = positionsSchema.parse(fixture('positions.json'))
const long = positions[0]
const short = positions[1]
if (long === undefined || short === undefined) throw new Error('fixture missing positions')

describe('side translation', () => {
  it('maps domain to wire and back, lowercase on the wire', () => {
    expect(toWireSide('Buy')).toBe('buy')
    expect(toWireSide('Sell')).toBe('sell')
    expect(fromWireSide('buy')).toBe('Buy')
    expect(fromWireSide('sell')).toBe('Sell')
  })

  it('derives direction from the signed qty and the closing side from that', () => {
    expect(sideFromQty('0.5')).toBe('Buy')
    expect(sideFromQty('-4')).toBe('Sell')
    expect(closingSide(sideFromQty('0.5'))).toBe('Sell')
    expect(closingSide(sideFromQty('-4'))).toBe('Buy')
  })
})

describe('slippage units', () => {
  it('converts bps to the venue fraction', () => {
    expect(bpsToFraction(50)).toBe(0.005)
    expect(bpsToFraction(100)).toBe(0.01)
    expect(bpsToFraction(300)).toBe(0.03)
    expect(bpsToFraction(0)).toBe(0)
  })

  it('round-trips', () => {
    expect(fractionToBps(bpsToFraction(275))).toBeCloseTo(275, 6)
  })

  it('refuses values outside the venue-accepted [0, 0.5]', () => {
    expect(() => bpsToFraction(5001)).toThrow(InvalidRequestError)
    expect(() => bpsToFraction(-1)).toThrow(InvalidRequestError)
    expect(bpsToFraction(5000)).toBe(0.5)
  })
})

describe('timestamps', () => {
  it('parses nanosecond precision by truncating to ms', () => {
    expect(parseTimestamp('2026-08-13T15:56:14.566862Z')).toBe(
      Date.parse('2026-08-13T15:56:14.566Z'),
    )
  })

  it('returns undefined for absent or unparseable input', () => {
    expect(parseTimestamp(undefined)).toBeUndefined()
    expect(parseTimestamp(null)).toBeUndefined()
    expect(parseTimestamp('not a date')).toBeUndefined()
  })
})

describe('toExchangePosition', () => {
  it('translates a long, keeping qty unsigned and direction in side', () => {
    const pos = toExchangePosition(long, { fallbackTs: 1 })
    expect(pos).toMatchObject({
      key: 'P-BTC-USDC-3600:cross',
      instrumentId: 'P-BTC-USDC-3600',
      subAccount: 'cross',
      side: 'Buy',
      qty: 0.5,
      entry: 63000,
      markPrice: 63561.68,
      liquidationPrice: 58012.4,
    })
    expect(pos.updatedAt).toBe(Date.parse('2026-08-13T15:40:00Z'))
  })

  it('translates a short and omits an absent liquidation price', () => {
    const pos = toExchangePosition(short, { fallbackTs: 1, subAccount: 'iso' })
    expect(pos.side).toBe('Sell')
    expect(pos.qty).toBe(4)
    expect(pos.key).toBe('P-ETH-USDC-3600:iso')
    expect(pos.liquidationPrice).toBeUndefined()
  })

  it('falls back to the supplied ts when the row carries none (no clock reads)', () => {
    const stripped = { ...long, position_info: { ...long.position_info, updated_at: null } }
    expect(toExchangePosition(stripped, { fallbackTs: 12_345 }).updatedAt).toBe(12_345)
  })
})

describe('reject classification', () => {
  it('recognises the rejected_ prefix', () => {
    expect(isRejected('rejected_maker_last_look_expired')).toBe(true)
    expect(isRejected('success_trades_booked_into_pool')).toBe(false)
    expect(isRejected(null)).toBe(false)
  })

  it('treats an already-flat reduce-only reject and no_positions cancels as benign', () => {
    expect(isBenignReject('rejected_failed_reduce_only_check')).toBe(true)
    expect(isBenignReject(null, 'no_positions')).toBe(true)
    expect(isBenignReject('rejected_failed_taker_funding')).toBe(false)
  })
})
