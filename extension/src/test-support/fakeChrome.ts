/**
 * A minimal in-memory `chrome.*` stand-in.
 *
 * Test-only. Nothing under `src/background` or `src/popup` imports it, so esbuild
 * never pulls it into the shipped bundle — the extension's two entry points are
 * the only roots it walks.
 *
 * It implements exactly the surface the extension uses: cookies, permissions,
 * storage.local, action (badge), alarms and runtime.
 */

import type { RawCookie } from '../shared/cookies.js'

export interface FakeChromeConfig {
  cookies: RawCookie[]
  grantedOrigins: string[]
  storage: Record<string, unknown>
}

export interface FakeChrome {
  readonly config: FakeChromeConfig
  readonly badge: { text: string; color: string; title: string }
  install(): void
  uninstall(): void
}

const GLOBAL = globalThis as unknown as Record<string, unknown>

export function createFakeChrome(overrides: Partial<FakeChromeConfig> = {}): FakeChrome {
  const config: FakeChromeConfig = {
    cookies: [],
    grantedOrigins: ['https://omni.variational.io/*'],
    storage: {},
    ...overrides,
  }

  const badge = { text: '', color: '', title: '' }
  let previous: unknown

  const api = {
    cookies: {
      getAll: async () => config.cookies.map((c) => ({ ...c })),
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    permissions: {
      contains: async (query: { origins?: string[] }) =>
        (query.origins ?? []).every((o) => config.grantedOrigins.includes(o)),
      request: async () => true,
      remove: async () => true,
      onAdded: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined },
    },
    storage: {
      local: {
        get: async (key: string) => (key in config.storage ? { [key]: config.storage[key] } : {}),
        set: async (values: Record<string, unknown>) => {
          Object.assign(config.storage, values)
        },
      },
    },
    action: {
      setBadgeText: async (details: { text: string }) => {
        badge.text = details.text
      },
      setBadgeBackgroundColor: async (details: { color: string }) => {
        badge.color = details.color
      },
      setTitle: async (details: { title: string }) => {
        badge.title = details.title
      },
    },
    alarms: {
      clear: async () => true,
      create: async () => undefined,
      onAlarm: { addListener: () => undefined },
    },
    runtime: {
      id: 'fake-extension-id',
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
      onMessage: { addListener: () => undefined },
    },
  }

  return {
    config,
    badge,
    install() {
      previous = GLOBAL['chrome']
      GLOBAL['chrome'] = api
    },
    uninstall() {
      GLOBAL['chrome'] = previous
    },
  }
}
