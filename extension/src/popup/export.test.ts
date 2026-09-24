import { describe, expect, it, vi } from 'vitest'
import { buildSessionBundle } from '../shared/bundle.js'
import type { RawCookie } from '../shared/cookies.js'
import { type AnchorLike, copyBundle, type DownloadEnv, downloadBundle } from './export.js'

function b64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const TOKEN = `h.${b64url(JSON.stringify({ address: '0xabc', exp: 1_800_000_000 }))}.s`

function cookie(name: string, value: string): RawCookie {
  return {
    name,
    value,
    domain: '.variational.io',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    sameSite: 'lax',
  }
}

const BUNDLE = buildSessionBundle(TOKEN, [cookie('vr-token', 'abc')])
const EXPECTED = {
  token: TOKEN,
  cookies: 'vr-token=abc',
  address: '0xabc',
  expiresAt: 1_800_000_000_000,
}

describe('copyBundle', () => {
  it('writes the session.json text to the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    await copyBundle(BUNDLE, { writeText })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(writeText.mock.calls[0]?.[0]))).toEqual(EXPECTED)
  })

  it('copies ONE line, so it survives being pasted into a .env file', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    await copyBundle(BUNDLE, { writeText })
    expect(String(writeText.mock.calls[0]?.[0])).not.toMatch(/[\r\n]/)
  })

  it('propagates a refused clipboard write so the popup can say so', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('Document is not focused.')
    })
    await expect(copyBundle(BUNDLE, { writeText })).rejects.toThrow('not focused')
  })
})

describe('downloadBundle', () => {
  function fakeEnv() {
    const anchor: AnchorLike & { clicked: number } = {
      href: '',
      download: '',
      rel: '',
      clicked: 0,
      click() {
        this.clicked += 1
      },
    }
    const blobs: Blob[] = []
    const revoked: string[] = []
    const deferred: Array<() => void> = []
    const env: DownloadEnv = {
      createAnchor: () => anchor,
      createObjectURL: (blob) => {
        blobs.push(blob)
        return 'blob:fake/1'
      },
      revokeObjectURL: (url) => revoked.push(url),
      defer: (fn) => deferred.push(fn),
    }
    return { env, anchor, blobs, revoked, deferred }
  }

  it('saves session.json containing exactly the bundle', async () => {
    const { env, anchor, blobs } = fakeEnv()
    downloadBundle(BUNDLE, env)

    expect(anchor.download).toBe('session.json')
    expect(anchor.href).toBe('blob:fake/1')
    expect(anchor.clicked).toBe(1)
    expect(blobs).toHaveLength(1)
    expect(blobs[0]?.type).toBe('application/json')
    expect(JSON.parse(await (blobs[0] as Blob).text())).toEqual(EXPECTED)
  })

  it('revokes the blob URL only after the click, never before', () => {
    const { env, revoked, deferred } = fakeEnv()
    downloadBundle(BUNDLE, env)
    expect(revoked).toEqual([])
    for (const fn of deferred) fn()
    expect(revoked).toEqual(['blob:fake/1'])
  })
})
