import { defineConfig } from 'vitest/config'

/** Tests are pure: no network, no real browser — `chrome.*` and `fetch` are faked per test. */
export default defineConfig({
  test: {
    name: 'variational-session-exporter',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
