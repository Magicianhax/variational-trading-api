/**
 * MV3 service worker — event wiring only.
 *
 * Every listener is registered synchronously at the top level so that Chrome
 * records it as a wake-up reason and it survives the worker being suspended.
 * The worker holds no state of its own beyond a debounce handle, which is safe
 * to lose on suspension.
 *
 * With push off (the default) nothing here touches the network on its own: the
 * session is read only when the popup asks. Background checks exist solely to
 * keep a configured push server up to date.
 */

import { COOKIE_DEBOUNCE_MS, OMNI_ORIGIN, REFRESH_ALARM } from '../shared/constants.js'
import { isExcludedCookie } from '../shared/cookies.js'
import { errorMessage, logInfo, logWarn } from '../shared/log.js'
import {
  ExporterRequestSchema,
  type ExporterResponse,
  type RefreshReason,
} from '../shared/messages.js'
import { readState, runCycle } from './exporter.js'
import { readSettings, writeSettings } from './storage.js'

const OMNI_HOSTNAME = new URL(OMNI_ORIGIN).hostname

let debounce: ReturnType<typeof setTimeout> | null = null

/** Background refresh — a no-op unless push is on. */
function scheduleRefresh(reason: RefreshReason, delayMs: number): void {
  if (debounce !== null) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    void (async () => {
      if (!(await readSettings()).pushEnabled) return
      await runCycle({ reason, forcePush: false })
    })().catch((error: unknown) => {
      logWarn('Refresh cycle failed', { reason, detail: errorMessage(error) })
    })
  }, delayMs)
}

async function rescheduleAlarm(): Promise<void> {
  const settings = await readSettings()
  await chrome.alarms.clear(REFRESH_ALARM)
  if (!settings.pushEnabled) return
  await chrome.alarms.create(REFRESH_ALARM, {
    periodInMinutes: settings.refreshMinutes,
    delayInMinutes: settings.refreshMinutes,
  })
}

async function bootstrap(reason: RefreshReason): Promise<void> {
  await rescheduleAlarm()
  scheduleRefresh(reason, 0)
}

/** True for a cookie the venue could send to `/api` — i.e. `.variational.io` or the host itself. */
function isVenueCookieDomain(domain: string): boolean {
  const bare = domain.startsWith('.') ? domain.slice(1) : domain
  return OMNI_HOSTNAME === bare || OMNI_HOSTNAME.endsWith(`.${bare}`)
}

// --- listeners -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  logInfo('Installed / updated.')
  void bootstrap('install').catch((error: unknown) => {
    logWarn('Bootstrap failed', { detail: errorMessage(error) })
  })
})

chrome.runtime.onStartup.addListener(() => {
  void bootstrap('startup').catch((error: unknown) => {
    logWarn('Bootstrap failed', { detail: errorMessage(error) })
  })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM) return
  scheduleRefresh('alarm', 0)
})

chrome.cookies.onChanged.addListener((info) => {
  if (!isVenueCookieDomain(info.cookie.domain)) return
  // Cloudflare rotates `__cf_bm` every half hour and analytics cookies churn
  // constantly; neither is part of the session, so neither should wake us up.
  if (isExcludedCookie(info.cookie.name)) return
  scheduleRefresh('cookie-change', COOKIE_DEBOUNCE_MS)
})

chrome.permissions.onAdded.addListener(() => {
  scheduleRefresh('permissions-change', 0)
})

chrome.permissions.onRemoved.addListener(() => {
  scheduleRefresh('permissions-change', 0)
})

async function handleRequest(raw: unknown): Promise<ExporterResponse> {
  const parsed = ExporterRequestSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Unrecognised message.' }
  const request = parsed.data

  switch (request.type) {
    case 'getState':
      return { ok: true, state: await readState(), bundle: null }
    case 'refresh':
      return { ok: true, ...(await runCycle({ reason: request.reason, forcePush: false })) }
    case 'pushNow':
      return { ok: true, ...(await runCycle({ reason: 'manual', forcePush: true })) }
    case 'saveSettings': {
      await writeSettings(request.settings)
      await rescheduleAlarm()
      return { ok: true, ...(await runCycle({ reason: 'settings-change', forcePush: false })) }
    }
    case 'permissionsChanged':
      return { ok: true, ...(await runCycle({ reason: 'permissions-change', forcePush: false })) }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only this extension's own pages may drive it — the response can carry the
  // live session. `externally_connectable` is not declared, so this is
  // belt-and-braces.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Forbidden.' } satisfies ExporterResponse)
    return false
  }
  handleRequest(message).then(sendResponse, (error: unknown) => {
    sendResponse({ ok: false, error: errorMessage(error) } satisfies ExporterResponse)
  })
  return true
})
