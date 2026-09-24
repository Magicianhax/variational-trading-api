import { defineConfig } from 'vitest/config'

/** Tests are pure: no network, no real timers, no randomness — every boundary is injected. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
