/**
 * `chrome.storage.local` access.
 *
 * `storage.local` — never `storage.sync` — because the server token is a bearer
 * secret and `sync` would replicate it to every browser signed into the same
 * Google account. The session itself is never stored: only its digest.
 *
 * Persisted values are treated as an external boundary: they may have been
 * written by an older version of the extension, so everything is zod-parsed on
 * the way out with a well-defined fallback.
 */

import { STORAGE_KEYS } from '../shared/constants.js'
import { logWarn } from '../shared/log.js'
import { DEFAULT_SETTINGS, parseSettings, type Settings } from '../shared/settings.js'
import { type ExporterStatus, ExporterStatusSchema, INITIAL_STATUS } from '../shared/status.js'

export async function readSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings)
  const value = raw[STORAGE_KEYS.settings]
  if (value === undefined) return { ...DEFAULT_SETTINGS }
  return parseSettings(value)
}

export async function writeSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings })
}

export async function readStatus(): Promise<ExporterStatus> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.status)
  const value = raw[STORAGE_KEYS.status]
  if (value === undefined) return INITIAL_STATUS
  const parsed = ExporterStatusSchema.safeParse(value)
  if (!parsed.success) {
    logWarn('Persisted status did not parse; resetting to initial status.')
    return INITIAL_STATUS
  }
  return parsed.data
}

export async function writeStatus(status: ExporterStatus): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.status]: status })
}
