import { describe, expect, it } from 'vitest'
import * as S from '../src/schemas.js'

describe('supported assets: unknown instrument types', () => {
  it('drops a listing it cannot model instead of rejecting the catalogue', () => {
    // Variational shipped `swap` instruments on 2026-09-12; the strict enum rejected the
    // whole response, so nothing could trade — even symbols whose rows parsed fine.
    const raw = {
      BTC: [{ asset: 'BTC', instrument_type: 'perpetual_future' }],
      US100S: [{ asset: 'US100S', instrument_type: 'swap' }],
      SOL: [{ asset: 'SOL', instrument_type: 'perpetual_future' }],
    }
    const parsed = S.supportedAssetsSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    const out = parsed.data as Record<string, unknown[]>
    expect(Object.keys(out).sort()).toEqual(['BTC', 'SOL']) // the swap is dropped
    expect(out['US100S']).toBeUndefined()
  })

  it('still parses a wholly valid catalogue unchanged', () => {
    const raw = { ETH: [{ asset: 'ETH', instrument_type: 'perpetual_rwa_future' }] }
    const parsed = S.supportedAssetsSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    expect(Object.keys(parsed.data as object)).toEqual(['ETH'])
  })
})
