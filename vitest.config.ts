import { defineConfig } from 'vitest/config'

/**
 * Tests are pure: no network, no real timers, no randomness — every boundary is injected.
 * One run covers the client and the extension, so `pnpm test <file>` filters across both.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'client',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      'extension',
    ],
  },
})
