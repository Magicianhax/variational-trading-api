import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings, resolveServerTarget } from './settings.js'

describe('resolveServerTarget', () => {
  it('accepts https and derives a port-agnostic match pattern', () => {
    const result = resolveServerTarget('https://bot.example.com:8443/api/')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.target.base).toBe('https://bot.example.com:8443/api')
    expect(result.target.originPattern).toBe('https://bot.example.com/*')
    expect(result.target.loopback).toBe(false)
  })

  it('strips a bare trailing slash so URLs are joined cleanly', () => {
    const result = resolveServerTarget('https://bot.example.com/')
    expect(result.ok && result.target.base).toBe('https://bot.example.com')
  })

  it('allows plaintext http only on loopback', () => {
    for (const url of ['http://127.0.0.1:8080', 'http://localhost:8080']) {
      const result = resolveServerTarget(url)
      expect(result.ok).toBe(true)
      expect(result.ok && result.target.loopback).toBe(true)
    }
  })

  it('rejects plaintext http to anywhere else', () => {
    const result = resolveServerTarget('http://bot.example.com')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('https://')
  })

  it('rejects empty, relative, credentialed and query-bearing URLs', () => {
    expect(resolveServerTarget('').ok).toBe(false)
    expect(resolveServerTarget('   ').ok).toBe(false)
    expect(resolveServerTarget('/session').ok).toBe(false)
    expect(resolveServerTarget('bot.example.com').ok).toBe(false)
    expect(resolveServerTarget('https://user:pass@bot.example.com').ok).toBe(false)
    expect(resolveServerTarget('https://bot.example.com/?a=1').ok).toBe(false)
    expect(resolveServerTarget('https://bot.example.com/#x').ok).toBe(false)
  })

  it('rejects non-http(s) schemes', () => {
    expect(resolveServerTarget('ws://bot.example.com').ok).toBe(false)
    expect(resolveServerTarget('file:///etc/passwd').ok).toBe(false)
  })
})

describe('parseSettings', () => {
  it('ships with push off, so a fresh install contacts no server', () => {
    expect(DEFAULT_SETTINGS.pushEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.serverUrl).toBe('')
    expect(DEFAULT_SETTINGS.serverToken).toBe('')
  })

  it('returns defaults for anything unusable', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS)
  })

  it('fills missing fields from defaults while keeping the stored ones', () => {
    const parsed = parseSettings({ serverUrl: 'https://bot.example.com', serverToken: 'tok' })
    expect(parsed).toEqual({
      ...DEFAULT_SETTINGS,
      serverUrl: 'https://bot.example.com',
      serverToken: 'tok',
    })
  })

  it('falls back to defaults when a stored field has the wrong type', () => {
    expect(parseSettings({ serverUrl: 12, refreshMinutes: 'soon' })).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects an out-of-range refresh interval', () => {
    expect(parseSettings({ ...DEFAULT_SETTINGS, refreshMinutes: 0 })).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings({ ...DEFAULT_SETTINGS, refreshMinutes: 10_000 })).toEqual(DEFAULT_SETTINGS)
  })

  it('drops unknown stored keys rather than carrying them forward', () => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, legacyField: 'x' })
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })
})
