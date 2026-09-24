import { describe, expect, it } from 'vitest'
import type { OmniJwtClaims } from './jwt.js'
import {
  classifyToken,
  type ExporterStatus,
  formatDuration,
  INITIAL_STATUS,
  isExportable,
  type SessionState,
  shouldPush,
  warningLevel,
} from './status.js'

const NOW = 1_700_000_000_000

function claims(overrides: Partial<OmniJwtClaims> = {}): OmniJwtClaims {
  return { address: null, exp: null, scope: null, ...overrides }
}

describe('classifyToken', () => {
  it('reports an empty token as signed out', () => {
    expect(classifyToken('', claims(), NOW).state).toBe('absent')
  })

  it('accepts a token with no exp claim', () => {
    const result = classifyToken('tok', claims(), NOW)
    expect(result.state).toBe('ok')
    expect(result.expiresAt).toBeNull()
  })

  it('is ok well before expiry, expiring inside the window, expired after', () => {
    const exp = (offsetMs: number): OmniJwtClaims => claims({ exp: (NOW + offsetMs) / 1000 })
    expect(classifyToken('t', exp(60 * 60_000), NOW).state).toBe('ok')
    expect(classifyToken('t', exp(5 * 60_000), NOW).state).toBe('expiring')
    expect(classifyToken('t', exp(-1), NOW).state).toBe('expired')
  })

  it('treats the boundary itself as expiring, not ok', () => {
    const warnMs = 600_000
    const result = classifyToken('t', claims({ exp: (NOW + warnMs) / 1000 }), NOW, warnMs)
    expect(result.state).toBe('expiring')
  })
})

describe('isExportable', () => {
  it('hands out only a live session', () => {
    const exportable: SessionState[] = ['ok', 'expiring']
    const refused: SessionState[] = ['unknown', 'expired', 'absent', 'blocked', 'error']
    for (const state of exportable) expect(isExportable(state)).toBe(true)
    for (const state of refused) expect(isExportable(state)).toBe(false)
  })
})

describe('shouldPush', () => {
  const base = {
    pushEnabled: true,
    sessionState: 'ok' as SessionState,
    bundleFingerprint: 'aaa',
    lastAcceptedFingerprint: 'aaa',
    autoPush: true,
    forced: false,
  }

  it('never pushes while push is off, even when forced', () => {
    expect(shouldPush({ ...base, pushEnabled: false, lastAcceptedFingerprint: null })).toBe(false)
    expect(shouldPush({ ...base, pushEnabled: false, forced: true })).toBe(false)
  })

  it('does nothing when there is no bundle', () => {
    expect(shouldPush({ ...base, bundleFingerprint: null, forced: true })).toBe(false)
  })

  it('never pushes a signed-out or expired session, even when forced', () => {
    expect(shouldPush({ ...base, sessionState: 'absent', forced: true })).toBe(false)
    expect(shouldPush({ ...base, sessionState: 'expired', forced: true })).toBe(false)
  })

  it('pushes on an explicit request even when nothing changed', () => {
    expect(shouldPush({ ...base, forced: true })).toBe(true)
  })

  it('pushes when the credential changed', () => {
    expect(shouldPush({ ...base, lastAcceptedFingerprint: 'bbb' })).toBe(true)
    expect(shouldPush({ ...base, lastAcceptedFingerprint: null })).toBe(true)
  })

  it('stays quiet when the server already holds this session', () => {
    expect(shouldPush(base)).toBe(false)
  })

  it('does not auto-push when auto-push is off, but still honours a forced push', () => {
    expect(shouldPush({ ...base, autoPush: false, lastAcceptedFingerprint: 'bbb' })).toBe(false)
    expect(
      shouldPush({ ...base, autoPush: false, lastAcceptedFingerprint: 'bbb', forced: true }),
    ).toBe(true)
  })
})

describe('warningLevel', () => {
  function status(overrides: Partial<ExporterStatus>): ExporterStatus {
    return { ...INITIAL_STATUS, ...overrides }
  }
  const signedIn = { ...INITIAL_STATUS.session, state: 'ok' as const, fingerprint: 'a' }

  it('escalates a dead browser session to error', () => {
    for (const state of ['absent', 'expired', 'error'] as const) {
      expect(warningLevel(status({ session: { ...INITIAL_STATUS.session, state } }))).toBe('error')
    }
  })

  it('escalates a failing push to error', () => {
    for (const state of ['error', 'unauthorized', 'no-permission'] as const) {
      expect(
        warningLevel(status({ session: signedIn, push: { ...INITIAL_STATUS.push, state } })),
      ).toBe('error')
    }
  })

  it('warns on an expiring or blocked session', () => {
    for (const state of ['expiring', 'blocked'] as const) {
      expect(warningLevel(status({ session: { ...signedIn, state } }))).toBe('warn')
    }
  })

  it('is ok for a live session with push off — push is optional, not a problem', () => {
    expect(warningLevel(status({ session: signedIn }))).toBe('ok')
  })

  it('warns while a newer session is still waiting to be pushed', () => {
    expect(
      warningLevel(
        status({
          session: signedIn,
          push: { ...INITIAL_STATUS.push, state: 'ok', fingerprint: 'old' },
          pendingPush: true,
        }),
      ),
    ).toBe('warn')
  })
})

describe('formatDuration', () => {
  it('formats each magnitude', () => {
    expect(formatDuration(-5)).toBe('0s')
    expect(formatDuration(47_000)).toBe('47s')
    expect(formatDuration(133_000)).toBe('2m 13s')
    expect(formatDuration(7_980_000)).toBe('2h 13m')
    expect(formatDuration(360_000_000)).toBe('4d 4h')
  })
})
