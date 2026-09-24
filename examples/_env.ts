/**
 * Tiny .env reader for the examples, so they need no extra dependency.
 * Real environment variables win over the file.
 */
import { existsSync, readFileSync } from 'node:fs'

export function loadEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m?.[1] === undefined || line.trimStart().startsWith('#')) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2] ?? ''
  }
}

/** Anything other than an explicit "false" is dry run. */
export const isDryRun = (): boolean =>
  (process.env['DRY_RUN'] ?? 'true').trim().toLowerCase() !== 'false'
