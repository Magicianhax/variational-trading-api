/**
 * Shared plumbing for the examples and `pnpm session:check`, so they need no extra
 * dependency and, above all, agree on WHICH session they use.
 */
import { existsSync, readFileSync } from 'node:fs'
import { OmniClient, type OmniClientOptions } from '../dist/index.js'

/**
 * Tiny .env reader. Real environment variables win over the file. One `KEY=value` per
 * line; one pair of matching quotes around the value is removed, as dotenv does, so
 * `VARIATIONAL_COOKIES='...'` means the same as the unquoted form.
 */
export function loadEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m?.[1] === undefined || line.trimStart().startsWith('#')) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = unquote(m[2] ?? '')
  }
}

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
    return value.slice(1, -1)
  return value
}

/** Anything other than an explicit "false" is dry run. */
export const isDryRun = (): boolean =>
  (process.env['DRY_RUN'] ?? 'true').trim().toLowerCase() !== 'false'

export type SessionSource = {
  /** What to hand to `loadSession`: a path, or the env var's value. */
  source: string
  /** Where it came from, for messages. Never holds a secret. */
  label: string
}

/**
 * Where the session comes from, in the one documented order (README, docs/AUTH.md):
 *
 *   1. a path given on the command line;
 *   2. ./session.json;
 *   3. VARIATIONAL_COOKIES, from the environment or .env.
 *
 * A fresh session.json from the extension must win over an old cookie line left in
 * .env; with any other order `session:check` and the examples could disagree about
 * which session is in use.
 */
export function resolveSessionSource(argPath?: string): SessionSource | undefined {
  if (argPath !== undefined && argPath !== '') return { source: argPath, label: argPath }
  if (existsSync('session.json')) return { source: 'session.json', label: './session.json' }
  loadEnv()
  // An empty `VARIATIONAL_COOKIES=` line in .env means "not set".
  const env = process.env['VARIATIONAL_COOKIES']?.trim()
  if (env) return { source: env, label: 'VARIATIONAL_COOKIES' }
  return undefined
}

const HOW_TO_FIX =
  'Export a session (docs/AUTH.md) or set VARIATIONAL_COOKIES, then run `pnpm session:check`.'

/** Print a one-line reason plus what to do, and exit 1. No stack, no error fields. */
export function exitWith(message: string, hint = HOW_TO_FIX): never {
  console.error(hint === '' ? `\n${message}\n` : `\n${message}\n\n${hint}\n`)
  process.exit(1)
}

/**
 * Print only an error's name and message, never its fields. Node's default printer
 * shows every own property, and a `SchemaDriftError` on `/me` carries the response
 * body. The client already redacts tokens there; this keeps the terminal clean even
 * for errors that do not come from the client.
 */
export function printErrorsSafely(): void {
  process.on('uncaughtException', (err) => {
    const shown = err instanceof Error ? `${err.name}: ${err.message}` : 'unexpected error'
    exitWith(shown, 'See README.md > Troubleshooting.')
  })
}

/**
 * The session client for an example: resolves the session (see
 * {@link resolveSessionSource}), and on a missing or unusable session prints what to do
 * and exits instead of throwing a stack trace at someone on their first run.
 */
export function clientFromEnv(options: Omit<OmniClientOptions, 'cookies'> = {}): OmniClient {
  loadEnv()
  printErrorsSafely()
  const found = resolveSessionSource(process.argv[2])
  if (found === undefined)
    exitWith('No session found: no ./session.json, and VARIATIONAL_COOKIES is not set.')
  try {
    return OmniClient.fromSession(found.source, options)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // loadSession's own messages already say what to do next; don't say it twice.
    return exitWith(
      `${found.label}: ${message}`,
      message.includes('session:check') ? '' : HOW_TO_FIX,
    )
  }
}
