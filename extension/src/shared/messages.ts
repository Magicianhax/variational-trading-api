/**
 * Message protocol between the popup and the service worker.
 *
 * `externally_connectable` is not declared and there are no content scripts, so
 * only this extension's own pages can send these messages. Requests are still
 * zod-validated in the worker: a malformed message must produce a clean error,
 * never an unhandled rejection that tears the worker down mid-push.
 */

import * as z from 'zod/mini'
import type { SessionBundle } from './bundle.js'
import { type Settings, SettingsSchema } from './settings.js'
import type { ExporterStatus } from './status.js'

export const RefreshReasonSchema = z.enum([
  'manual',
  'alarm',
  'startup',
  'install',
  'cookie-change',
  'permissions-change',
  'settings-change',
  'popup-open',
])
export type RefreshReason = z.infer<typeof RefreshReasonSchema>

export const ExporterRequestSchema = z.discriminatedUnion('type', [
  /** Cached status only — no network. Lets the popup paint instantly. */
  z.object({ type: z.literal('getState') }),
  z.object({ type: z.literal('refresh'), reason: RefreshReasonSchema }),
  /** Push even if the server already accepted this session ("Push now"). */
  z.object({ type: z.literal('pushNow') }),
  z.object({ type: z.literal('saveSettings'), settings: SettingsSchema }),
  /** The popup granted or revoked a host permission. */
  z.object({ type: z.literal('permissionsChanged') }),
])
export type ExporterRequest = z.infer<typeof ExporterRequestSchema>

export interface ExporterState {
  readonly settings: Settings
  readonly status: ExporterStatus
  /** Validation error for the configured server URL, or null when it is valid or push is off. */
  readonly serverUrlError: string | null
  /** True when the server origin's host permission has been granted. */
  readonly serverOriginGranted: boolean
  /** Match pattern the popup must request, or null when push is off or the URL is invalid. */
  readonly serverOriginPattern: string | null
  /** True when `https://omni.variational.io/*` is granted (it is required). */
  readonly omniHostGranted: boolean
}

export type ExporterResponse =
  | {
      readonly ok: true
      readonly state: ExporterState
      /**
       * The live session, present only after a fresh read of an exportable one.
       * Kept in the popup's memory for Copy / Download; never written to storage.
       */
      readonly bundle: SessionBundle | null
    }
  | { readonly ok: false; readonly error: string }
