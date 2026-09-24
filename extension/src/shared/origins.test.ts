import { describe, expect, it } from 'vitest'
import { staleOrigins } from './origins.js'

const VENUE = 'https://omni.variational.io/*'

describe('staleOrigins', () => {
  it('returns earlier push servers, never the current one or the venue', () => {
    const granted = [VENUE, 'https://old.example.com/*', 'https://new.example.com/*']
    expect(staleOrigins(granted, 'https://new.example.com/*', [VENUE])).toEqual([
      'https://old.example.com/*',
    ])
  })

  it('treats every optional grant as stale when push is off', () => {
    const granted = [VENUE, 'http://localhost/*']
    expect(staleOrigins(granted, null, [VENUE])).toEqual(['http://localhost/*'])
  })
})
