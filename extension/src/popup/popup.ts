/**
 * Popup / options UI.
 *
 * The popup owns no session logic: it renders what the service worker reports
 * and sends it commands. Three things it must do itself because they need the
 * click's user gesture: write the clipboard, start the download, and call
 * `chrome.permissions.request`.
 */

import type { SessionBundle } from '../shared/bundle.js'
import { OMNI_HOST_PERMISSION } from '../shared/constants.js'
import type { ExporterRequest, ExporterResponse, ExporterState } from '../shared/messages.js'
import { DEFAULT_SETTINGS, resolveServerTarget, type Settings } from '../shared/settings.js'
import {
  formatDuration,
  isExportable,
  type PushState,
  type SessionState,
  warningLevel,
} from '../shared/status.js'
import { browserDownloadEnv, copyBundle, downloadBundle } from './export.js'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`Missing element #${id}`)
  return node as T
}

const dom = {
  overallPill: el<HTMLSpanElement>('overall-pill'),

  sessionPill: el<HTMLSpanElement>('session-pill'),
  sessionDetail: el<HTMLParagraphElement>('session-detail'),
  signinHint: el<HTMLParagraphElement>('signin-hint'),
  sessionAddress: el<HTMLElement>('session-address'),
  sessionExpiry: el<HTMLElement>('session-expiry'),
  sessionCookies: el<HTMLElement>('session-cookies'),
  sessionDropped: el<HTMLParagraphElement>('session-dropped'),
  copy: el<HTMLButtonElement>('copy'),
  download: el<HTMLButtonElement>('download'),
  refresh: el<HTMLButtonElement>('refresh'),
  exportDetail: el<HTMLParagraphElement>('export-detail'),

  permissionCard: el<HTMLElement>('permission-card'),
  permissionDetail: el<HTMLParagraphElement>('permission-detail'),
  grant: el<HTMLButtonElement>('grant'),

  form: el<HTMLFormElement>('settings-form'),
  pushEnabled: el<HTMLInputElement>('push-enabled'),
  pushFields: el<HTMLFieldSetElement>('push-fields'),
  serverUrl: el<HTMLInputElement>('server-url'),
  serverUrlError: el<HTMLElement>('server-url-error'),
  serverToken: el<HTMLInputElement>('server-token'),
  toggleToken: el<HTMLButtonElement>('toggle-token'),
  autoPush: el<HTMLInputElement>('auto-push'),
  refreshMinutes: el<HTMLInputElement>('refresh-minutes'),
  saveDetail: el<HTMLElement>('save-detail'),

  pushPill: el<HTMLSpanElement>('push-pill'),
  pushStatus: el<HTMLElement>('push-status'),
  pushDetail: el<HTMLParagraphElement>('push-detail'),
  pushWhen: el<HTMLElement>('push-when'),
  pushNow: el<HTMLButtonElement>('push-now'),
  pushActionDetail: el<HTMLParagraphElement>('push-action-detail'),
}

type Level = 'ok' | 'warn' | 'error' | 'unknown'

const SESSION_LABEL: Record<SessionState, string> = {
  unknown: 'checking…',
  ok: 'signed in',
  expiring: 'expiring',
  expired: 'expired',
  absent: 'signed out',
  blocked: 'blocked',
  error: 'error',
}

const SESSION_LEVEL: Record<SessionState, Level> = {
  unknown: 'unknown',
  ok: 'ok',
  expiring: 'warn',
  expired: 'error',
  absent: 'error',
  blocked: 'warn',
  error: 'error',
}

const PUSH_LABEL: Record<PushState, string> = {
  off: 'off',
  never: 'not pushed yet',
  ok: 'delivered',
  error: 'failed',
  unauthorized: 'token refused',
  unconfigured: 'not configured',
  'no-permission': 'needs permission',
  'no-session': 'nothing to push',
}

const PUSH_LEVEL: Record<PushState, Level> = {
  off: 'unknown',
  never: 'warn',
  ok: 'ok',
  error: 'error',
  unauthorized: 'error',
  unconfigured: 'warn',
  'no-permission': 'error',
  'no-session': 'warn',
}

/** The live session, held only in this popup's memory for Copy / Download. */
let currentBundle: SessionBundle | null = null
let lastState: ExporterState | null = null
let busy = false

function setPill(node: HTMLElement, label: string, level: Level): void {
  node.textContent = label
  node.className = `pill pill-${level}`
}

function formatAbsolute(ms: number): string {
  return new Date(ms).toLocaleString()
}

function formatRelative(ms: number, nowMs: number): string {
  const delta = ms - nowMs
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`
}

function formatExpiry(ms: number | null, nowMs: number): string {
  if (ms === null) return '—'
  return `${formatRelative(ms, nowMs)} (${formatAbsolute(ms)})`
}

function canExport(state: ExporterState | null): boolean {
  return state !== null && currentBundle !== null && isExportable(state.status.session.state)
}

function syncButtons(): void {
  const exportable = canExport(lastState)
  dom.copy.disabled = busy || !exportable
  dom.download.disabled = busy || !exportable
  dom.refresh.disabled = busy
  const pushReady =
    lastState?.settings.pushEnabled === true &&
    lastState.serverOriginGranted &&
    lastState.status.session.fingerprint !== null
  dom.pushNow.disabled = busy || !pushReady
}

function render(state: ExporterState): void {
  lastState = state
  const now = Date.now()
  const { status, settings } = state
  const session = status.session

  const overall = warningLevel(status)
  setPill(
    dom.overallPill,
    session.state === 'unknown'
      ? 'checking…'
      : overall === 'ok'
        ? 'ready'
        : overall === 'warn'
          ? 'attention'
          : 'action needed',
    session.state === 'unknown' ? 'unknown' : overall,
  )

  // --- session ---
  setPill(dom.sessionPill, SESSION_LABEL[session.state], SESSION_LEVEL[session.state])
  dom.sessionDetail.textContent = session.detail
  const needsSignIn = session.state === 'absent' || session.state === 'expired'
  dom.signinHint.classList.toggle('hidden', !needsSignIn)
  dom.sessionAddress.textContent = session.address ?? '—'
  dom.sessionExpiry.textContent = formatExpiry(session.expiresAt, now)
  dom.sessionCookies.textContent = session.state === 'unknown' ? '—' : `${session.cookieCount}`
  dom.sessionDropped.textContent =
    session.droppedCookies.length > 0
      ? `Left out ${session.droppedCookies.length} analytics/Cloudflare cookie(s): ${session.droppedCookies.join(', ')}`
      : ''

  // --- permissions ---
  const needsServerGrant = state.serverOriginPattern !== null && !state.serverOriginGranted
  const needsOmniGrant = !state.omniHostGranted
  dom.permissionCard.classList.toggle('hidden', !needsServerGrant && !needsOmniGrant)
  if (needsOmniGrant) {
    dom.permissionDetail.textContent =
      'Access to omni.variational.io is turned off, so the session cannot be read.'
    dom.grant.textContent = 'Grant access to omni.variational.io'
    dom.grant.dataset['origin'] = OMNI_HOST_PERMISSION
  } else if (needsServerGrant && state.serverOriginPattern !== null) {
    dom.permissionDetail.textContent = `Push needs permission to contact ${state.serverOriginPattern}.`
    dom.grant.textContent = 'Grant access'
    dom.grant.dataset['origin'] = state.serverOriginPattern
  }

  // --- push ---
  const pushOn = settings.pushEnabled
  dom.pushPill.classList.toggle('hidden', !pushOn)
  dom.pushStatus.classList.toggle('hidden', !pushOn)
  if (pushOn) {
    setPill(dom.pushPill, PUSH_LABEL[status.push.state], PUSH_LEVEL[status.push.state])
    dom.pushDetail.textContent = status.pendingPush
      ? `${status.push.detail} A newer session has not been pushed yet.`
      : status.push.detail
    dom.pushWhen.textContent =
      status.push.at === null
        ? '—'
        : `${formatRelative(status.push.at, now)} (${formatAbsolute(status.push.at)})`
  }

  // --- settings (never overwrite a field the user is typing in) ---
  if (document.activeElement !== dom.pushEnabled) {
    dom.pushEnabled.checked = settings.pushEnabled
    dom.pushFields.classList.toggle('hidden', !settings.pushEnabled)
  }
  if (document.activeElement !== dom.serverUrl) dom.serverUrl.value = settings.serverUrl
  if (document.activeElement !== dom.serverToken) dom.serverToken.value = settings.serverToken
  if (document.activeElement !== dom.autoPush) dom.autoPush.checked = settings.autoPush
  if (document.activeElement !== dom.refreshMinutes) {
    dom.refreshMinutes.value = `${settings.refreshMinutes}`
  }
  dom.serverUrlError.textContent = state.serverUrlError ?? ''

  syncButtons()
}

async function send(
  request: ExporterRequest,
): Promise<{ state: ExporterState; bundle: SessionBundle | null }> {
  const response: unknown = await chrome.runtime.sendMessage(request)
  const typed = response as ExporterResponse | undefined
  if (typed === undefined) throw new Error('The extension background did not respond.')
  if (!typed.ok) throw new Error(typed.error)
  return { state: typed.state, bundle: typed.bundle }
}

/**
 * Run a command that re-reads the session. Its bundle replaces the one in memory,
 * including with null — a session that just signed out must not stay exportable.
 */
async function withBusy(
  node: HTMLElement,
  work: () => Promise<{ state: ExporterState; bundle: SessionBundle | null }>,
): Promise<void> {
  busy = true
  syncButtons()
  node.textContent = 'Working…'
  try {
    const result = await work()
    currentBundle = result.bundle
    render(result.state)
    node.textContent = ''
  } catch (error) {
    node.textContent = error instanceof Error ? error.message : 'Unexpected error.'
  } finally {
    busy = false
    syncButtons()
  }
}

function readSettingsForm(): { settings: Settings; error: string | null } {
  const parsedMinutes = Number.parseInt(dom.refreshMinutes.value, 10)
  const settings: Settings = {
    pushEnabled: dom.pushEnabled.checked,
    serverUrl: dom.serverUrl.value.trim(),
    serverToken: dom.serverToken.value.trim(),
    autoPush: dom.autoPush.checked,
    refreshMinutes: Number.isFinite(parsedMinutes)
      ? Math.min(360, Math.max(1, parsedMinutes))
      : DEFAULT_SETTINGS.refreshMinutes,
  }
  if (!settings.pushEnabled) return { settings, error: null }
  const target = resolveServerTarget(settings.serverUrl)
  return { settings, error: target.ok ? null : target.error }
}

// --- export ------------------------------------------------------------------

// Both handlers act synchronously on the bundle already in memory: the clipboard
// write needs the click's user activation, which a round-trip first could outlive.
dom.copy.addEventListener('click', () => {
  const bundle = currentBundle
  if (bundle === null) return
  copyBundle(bundle, navigator.clipboard).then(
    () => {
      dom.exportDetail.textContent = 'Copied. Save it as session.json and keep it private.'
    },
    (error: unknown) => {
      dom.exportDetail.textContent = `Copy failed: ${error instanceof Error ? error.message : 'unknown error'}. Use Download instead.`
    },
  )
})

dom.download.addEventListener('click', () => {
  const bundle = currentBundle
  if (bundle === null) return
  try {
    downloadBundle(bundle, browserDownloadEnv())
    dom.exportDetail.textContent = 'Saved session.json to your downloads folder.'
  } catch (error) {
    dom.exportDetail.textContent = `Download failed: ${error instanceof Error ? error.message : 'unknown error'}.`
  }
})

dom.refresh.addEventListener('click', () => {
  void withBusy(dom.exportDetail, () => send({ type: 'refresh', reason: 'manual' }))
})

// --- push --------------------------------------------------------------------

dom.pushNow.addEventListener('click', () => {
  void withBusy(dom.pushActionDetail, () => send({ type: 'pushNow' }))
})

dom.pushEnabled.addEventListener('change', () => {
  dom.pushFields.classList.toggle('hidden', !dom.pushEnabled.checked)
  dom.saveDetail.textContent = 'Press Save to apply.'
})

dom.toggleToken.addEventListener('click', () => {
  const revealed = dom.serverToken.type === 'text'
  dom.serverToken.type = revealed ? 'password' : 'text'
  dom.toggleToken.textContent = revealed ? 'show' : 'hide'
  dom.toggleToken.setAttribute('aria-pressed', revealed ? 'false' : 'true')
})

dom.form.addEventListener('submit', (event) => {
  event.preventDefault()
  const { settings, error } = readSettingsForm()
  dom.serverUrlError.textContent = error ?? ''
  if (error !== null) {
    dom.saveDetail.textContent = 'Fix the server URL first.'
    return
  }
  const save = () => withBusy(dom.saveDetail, () => send({ type: 'saveSettings', settings }))
  const target = settings.pushEnabled ? resolveServerTarget(settings.serverUrl) : null
  if (target === null || !target.ok) {
    void save()
    return
  }
  // `chrome.permissions.request` must be the first async step of the handler —
  // awaiting anything beforehand loses the user gesture and Chrome rejects it.
  // Settings are saved either way; a refusal shows up as "needs permission".
  chrome.permissions.request({ origins: [target.target.originPattern] }).then(
    () => void save(),
    () => void save(),
  )
})

dom.grant.addEventListener('click', () => {
  const origin = dom.grant.dataset['origin']
  if (origin === undefined || origin === '') return
  chrome.permissions.request({ origins: [origin] }).then(
    (granted) => {
      if (!granted) {
        dom.permissionDetail.textContent = 'Permission was not granted.'
        return
      }
      void withBusy(dom.exportDetail, () => send({ type: 'permissionsChanged' }))
    },
    (error: unknown) => {
      dom.permissionDetail.textContent =
        error instanceof Error ? error.message : 'Permission failed.'
    },
  )
})

// Paint the cached status immediately, then read the live session.
busy = true
syncButtons()
void send({ type: 'getState' })
  .then(({ state }) => {
    render(state)
    return withBusy(dom.exportDetail, () => send({ type: 'refresh', reason: 'popup-open' }))
  })
  .catch((error: unknown) => {
    busy = false
    syncButtons()
    dom.exportDetail.textContent = error instanceof Error ? error.message : 'Unexpected error.'
  })
