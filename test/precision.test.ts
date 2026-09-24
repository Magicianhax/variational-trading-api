import { describe, expect, it } from 'vitest'
import { InvalidRequestError } from '../src/errors.js'
import {
  countDecimals,
  formatPrice,
  formatQty,
  meetsMinNotional,
  qtyDecimalsFromTick,
  stripTrailingZeros,
  toPlainString,
  truncateToDecimals,
  validateQty,
} from '../src/precision.js'

describe('toPlainString', () => {
  it('expands exponential notation in both directions', () => {
    expect(toPlainString(1e-7)).toBe('0.0000001')
    expect(toPlainString('1.5e21')).toBe('1500000000000000000000')
    expect(toPlainString('2.5e-3')).toBe('0.0025')
    expect(toPlainString(-1.2e-4)).toBe('-0.00012')
  })

  it('leaves plain decimals and integers untouched', () => {
    expect(toPlainString('63555.71')).toBe('63555.71')
    expect(toPlainString(42)).toBe('42')
  })

  it('strips thousands separators and whitespace, as the bundle does', () => {
    expect(toPlainString(' 1,234.5 ')).toBe('1234.5')
  })
})

describe('decimal counting', () => {
  it('counts raw decimals', () => {
    expect(countDecimals('0.00100')).toBe(5)
    expect(countDecimals('100')).toBe(0)
    expect(countDecimals(1e-7)).toBe(7)
  })

  it('strips trailing zeros before deriving qty precision (c4 rule, the stricter one)', () => {
    // The bundle disagrees with itself here: `Ll` would say 5, `c4` says 3.
    expect(qtyDecimalsFromTick('0.00100')).toBe(3)
    expect(qtyDecimalsFromTick('0.000001')).toBe(6)
    expect(qtyDecimalsFromTick('1')).toBe(0)
  })

  it('stripTrailingZeros never mangles the integer part', () => {
    expect(stripTrailingZeros('1.2300')).toBe('1.23')
    expect(stripTrailingZeros('1.000')).toBe('1')
    expect(stripTrailingZeros('100')).toBe('100')
    expect(stripTrailingZeros('0.000')).toBe('0')
  })
})

describe('truncateToDecimals', () => {
  it('truncates toward zero, never rounds', () => {
    expect(truncateToDecimals('0.123456789', 6)).toBe('0.123456')
    expect(truncateToDecimals('0.9999999', 2)).toBe('0.99')
    expect(truncateToDecimals('-0.9999999', 2)).toBe('-0.99')
    expect(truncateToDecimals('1.5', 0)).toBe('1')
  })
})

describe('formatQty', () => {
  it('truncates to the tick precision and strips trailing zeros', () => {
    expect(formatQty('0.5000009', '0.000001')).toBe('0.5')
    expect(formatQty(0.123456789, '0.000001')).toBe('0.123456')
    expect(formatQty('3', '0.001')).toBe('3')
  })

  it('never rounds a reduce-only qty up past the position', () => {
    // 0.9999999 rounded would be 1.0 — bigger than the position we are closing.
    expect(Number(formatQty('0.9999999', '0.001'))).toBeLessThan(1)
  })

  it('rejects unsigned-only violations loudly', () => {
    expect(() => formatQty(-1, '0.001')).toThrow(InvalidRequestError)
    expect(() => formatQty(Number.NaN, '0.001')).toThrow(InvalidRequestError)
  })
})

describe('formatPrice', () => {
  it('kills binary float artefacts', () => {
    expect(formatPrice(61234.5 + 0.000000000004)).toBe('61234.5')
    expect(formatPrice(0.1 + 0.2)).toBe('0.3')
  })

  it('keeps genuine precision up to 8 decimals', () => {
    expect(formatPrice('63346.7543455801')).toBe('63346.75434558')
    expect(formatPrice(0)).toBe('0')
  })

  it('keeps significant digits on sub-cent prices instead of clamping them to zero', () => {
    // A DEX memecoin at 1.23e-7 used to become 0.00000012 (2.4% off); 4.9e-9 became 0.
    expect(formatPrice(1.23e-7)).toBe('0.000000123')
    expect(formatPrice(4.9e-9)).toBe('0.0000000049')
    // Float artefacts are still swallowed at any magnitude.
    expect(formatPrice(0.1e-6 * 3)).toBe('0.0000003')
    // And nothing changes above a cent.
    expect(formatPrice(0.00484793)).toBe('0.00484793')
  })

  it('rejects non-finite input', () => {
    expect(() => formatPrice(Number.POSITIVE_INFINITY)).toThrow(InvalidRequestError)
  })
})

describe('validateQty', () => {
  const limit = { min_qty: '0.000002', max_qty: '15786702.702446', min_qty_tick: '0.000001' }

  it('accepts a well-formed qty', () => {
    expect(validateQty('0.001', limit)).toEqual({ ok: true })
  })

  it('rejects below min, above max, and over-precise', () => {
    expect(validateQty('0.0000001', limit).ok).toBe(false)
    expect(validateQty('20000000', limit).ok).toBe(false)
    const tooPrecise = validateQty('0.0000025', limit)
    expect(tooPrecise.ok).toBe(false)
    if (!tooPrecise.ok) expect(tooPrecise.reason).toContain('decimals')
  })

  it('rejects zero and rubbish', () => {
    expect(validateQty('0', limit).ok).toBe(false)
    expect(validateQty('abc', limit).ok).toBe(false)
  })
})

describe('meetsMinNotional', () => {
  it('uses the live 0.1 USDC floor', () => {
    expect(meetsMinNotional('0.000002', '63346.75', '0.1')).toBe(true)
    expect(meetsMinNotional('0.000001', '63346.75', '0.1')).toBe(false)
  })
})
