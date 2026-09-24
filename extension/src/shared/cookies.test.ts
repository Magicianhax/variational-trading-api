import { describe, expect, it } from 'vitest'
import {
  droppedCookieNames,
  isAnalyticsCookie,
  isCloudflareCookie,
  isExcludedCookie,
  type RawCookie,
  selectSessionCookies,
  toCookieHeader,
} from './cookies.js'

function cookie(name: string, value = 'v', path = '/'): RawCookie {
  return {
    name,
    value,
    path,
    domain: '.variational.io',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    sameSite: 'lax',
    expirationDate: 1_800_000_000,
  }
}

describe('isAnalyticsCookie', () => {
  it('rejects known vendor cookies by exact name', () => {
    for (const name of ['_gid', '_dd_s', '_fbp', '_fbc', '_uetsid', '_uetvid', '_clck', 'lidc']) {
      expect(isAnalyticsCookie(name)).toBe(true)
    }
  })

  it('rejects known vendor cookies by prefix, case-insensitively', () => {
    for (const name of [
      '_ga',
      '_ga_ABC123',
      '_gat',
      '_gat_UA-1',
      '_hjSessionUser_1',
      'ajs_user_id',
      'amplitude_id_x',
      'intercom-session-xyz',
      'MP_abc',
      '__stripe_mid',
    ]) {
      expect(isAnalyticsCookie(name)).toBe(true)
    }
  })

  it('keeps anything that could plausibly be the first-party session', () => {
    // A denylist, not an allowlist: a renamed session cookie must still be exported.
    for (const name of ['vr-token', 'vr-connected-address', 'session', 'sid', '__Host-sess']) {
      expect(isAnalyticsCookie(name)).toBe(false)
    }
  })
})

describe('isCloudflareCookie', () => {
  it('rejects every Cloudflare cookie family', () => {
    for (const name of ['__cf_bm', '__cflb', '__cfruid', '_cfuvid', 'cf_clearance', 'cf_chl_rc']) {
      expect(isCloudflareCookie(name)).toBe(true)
    }
  })

  it('does not catch names that merely contain "cf"', () => {
    for (const name of ['vr-token', 'config', 'cfg', 'my_cf_thing']) {
      expect(isCloudflareCookie(name)).toBe(false)
    }
  })
})

describe('isExcludedCookie', () => {
  it('is the union of both denylists and nothing more', () => {
    expect(isExcludedCookie('_ga')).toBe(true)
    expect(isExcludedCookie('cf_clearance')).toBe(true)
    expect(isExcludedCookie('vr-token')).toBe(false)
  })
})

describe('selectSessionCookies', () => {
  it('drops analytics, Cloudflare and empty cookies, and orders deterministically', () => {
    const jar = [
      cookie('cf_clearance'),
      cookie('__cf_bm'),
      cookie('_cfuvid'),
      cookie('_ga'),
      cookie('vr-token'),
      cookie('emptied', ''),
      cookie('vr-token', 'other', '/api'),
      cookie('vr-connected-address'),
    ]
    expect(selectSessionCookies(jar).map((c) => `${c.name}${c.path}`)).toEqual([
      'vr-connected-address/',
      'vr-token/api',
      'vr-token/',
    ])
  })

  it('does not mutate its input', () => {
    const jar = [cookie('b'), cookie('a')]
    const snapshot = jar.map((c) => c.name)
    selectSessionCookies(jar)
    expect(jar.map((c) => c.name)).toEqual(snapshot)
  })

  it('reports what it dropped, de-duplicated and sorted', () => {
    const jar = [
      cookie('_ga'),
      cookie('_ga', 'x', '/api'),
      cookie('_dd_s'),
      cookie('cf_clearance'),
      cookie('vr-token'),
    ]
    expect(droppedCookieNames(jar)).toEqual(['_dd_s', '_ga', 'cf_clearance'])
  })
})

describe('toCookieHeader', () => {
  it('serialises as a Cookie header value', () => {
    expect(toCookieHeader([cookie('a', '1'), cookie('b', '2')])).toBe('a=1; b=2')
  })

  it('is empty for an empty jar', () => {
    expect(toCookieHeader([])).toBe('')
  })
})
