/**
 * The exporter cycle — the one place that decides what happens.
 *
 * A cycle is:
 *   1. read the browser's venue session (cookies + `/api/me` JWT)
 *   2. if push is on, deliver the bundle to the user's server when it changed
 *   3. persist the status (never the credential) and repaint the toolbar badge
 *
 * Cycles are serialised: a cookie change arriving mid-push queues behind the
 * running cycle instead of racing it.
 */

import { buildSessionBundle, fingerprintBundle, type SessionBundle } from '../shared/bundle.js'
import { OMNI_HOST_PERMISSION } from '../shared/constants.js'
import { decodeJwtClaims } from '../shared/jwt.js'
import { errorMessage, logInfo, logWarn, shortDigest } from '../shared/log.js'
import type { ExporterState, RefreshReason } from '../shared/messages.js'
import { resolveServerTarget, type Settings } from '../shared/settings.js'
import {
  classifyToken,
  type ExporterStatus,
  isExportable,
  type PushStatus,
  type SessionStatus,
  shouldPush,
  warningLevel,
} from '../shared/status.js'
import { harvestCookies, readSessionToken } from './omni.js'
import { hasOrigin } from './permissions.js'
import { pushSession } from './server.js'
import { readSettings, readStatus, writeStatus } from './storage.js'

interface SessionSnapshot {
  readonly status: SessionStatus
  /** Present only for a live (exportable) session. */
  readonly bundle: SessionBundle | null
}

function sessionFailure(
  state: SessionStatus['state'],
  detail: string,
  cookieCount = 0,
  droppedCookies: string[] = [],
): SessionSnapshot {
  return {
    bundle: null,
    status: {
      state,
      address: null,
      expiresAt: null,
      scope: null,
      cookieCount,
      droppedCookies,
      fingerprint: null,
      detail,
    },
  }
}

/** Step 1: read the browser's session and turn it into a status + a bundle. */
async function readBrowserSession(nowMs: number, omniGranted: boolean): Promise<SessionSnapshot> {
  if (!omniGranted) {
    return sessionFailure(
      'error',
      'Access to omni.variational.io is turned off. Allow it under chrome://extensions → Details → Site access.',
    )
  }

  let harvest: Awaited<ReturnType<typeof harvestCookies>>
  try {
    harvest = await harvestCookies()
  } catch (error) {
    return sessionFailure('error', `Could not read cookies: ${errorMessage(error)}`)
  }
  const cookieCount = harvest.cookies.length

  const probe = await readSessionToken()
  if (probe.kind === 'blocked') {
    return sessionFailure(
      'blocked',
      `${probe.detail} Open omni.variational.io in a tab, let it finish loading, then press Re-check.`,
      cookieCount,
      harvest.dropped,
    )
  }
  if (probe.kind === 'error') {
    return sessionFailure('error', probe.detail, cookieCount, harvest.dropped)
  }

  const claims = decodeJwtClaims(probe.token)
  const classification = classifyToken(probe.token, claims, nowMs)
  const status: SessionStatus = {
    state: classification.state,
    address: claims.address,
    expiresAt: classification.expiresAt,
    scope: claims.scope,
    cookieCount,
    droppedCookies: harvest.dropped,
    fingerprint: null,
    detail: classification.detail,
  }
  if (!isExportable(classification.state)) return { bundle: null, status }

  const bundle = buildSessionBundle(probe.token, harvest.cookies)
  return { bundle, status: { ...status, fingerprint: await fingerprintBundle(bundle) } }
}

function paintBadge(status: ExporterStatus, settings: Settings): void {
  // With push off nothing runs in the background, so a badge would only show how
  // things looked the last time the popup was open — worse than no badge at all.
  const level = settings.pushEnabled ? warningLevel(status) : 'ok'
  const text = level === 'ok' ? '' : level === 'warn' ? '!' : '×'
  void chrome.action.setBadgeText({ text })
  if (text !== '') {
    void chrome.action.setBadgeBackgroundColor({ color: level === 'warn' ? '#b45309' : '#b91c1c' })
  }
  void chrome.action.setTitle({
    title:
      settings.pushEnabled && level !== 'ok'
        ? `Variational Session Exporter — ${status.session.detail} / ${status.push.detail}`
        : 'Variational Session Exporter',
  })
}

interface CycleOptions {
  readonly reason: RefreshReason
  readonly forcePush: boolean
}

const PUSH_OFF: PushStatus = {
  state: 'off',
  at: null,
  fingerprint: null,
  server: null,
  detail: 'Push is off.',
}

/** Step 2: decide whether to push, and do it. */
async function settlePush(
  settings: Settings,
  session: SessionSnapshot,
  previous: PushStatus,
  options: CycleOptions,
  nowMs: number,
): Promise<PushStatus> {
  // Forgetting what was accepted means turning push back on re-delivers the
  // session, which is what someone re-enabling it after a server restart wants.
  if (!settings.pushEnabled) return PUSH_OFF

  const targetResult = resolveServerTarget(settings.serverUrl)
  const keep = { at: previous.at, fingerprint: previous.fingerprint, server: previous.server }

  if (!targetResult.ok) {
    return { ...keep, state: 'unconfigured', detail: targetResult.error }
  }
  if (settings.serverToken === '') {
    return { ...keep, state: 'unconfigured', detail: 'Server token is not set.' }
  }

  const target = targetResult.target
  if (!(await hasOrigin(target.originPattern))) {
    return {
      ...keep,
      state: 'no-permission',
      detail: `Access to ${target.origin} has not been granted yet.`,
    }
  }

  const fingerprint = session.status.fingerprint
  if (session.bundle === null || fingerprint === null) {
    return { ...keep, state: 'no-session', detail: 'No live session to push.' }
  }

  const lastAccepted = previous.server === target.base ? previous.fingerprint : null
  // What this server holds; a different server's acceptance says nothing about it.
  const accepted = {
    at: previous.at,
    fingerprint: lastAccepted,
    server: lastAccepted === null ? null : target.base,
  }
  const wants = shouldPush({
    pushEnabled: settings.pushEnabled,
    sessionState: session.status.state,
    bundleFingerprint: fingerprint,
    lastAcceptedFingerprint: lastAccepted,
    autoPush: settings.autoPush,
    forced: options.forcePush,
  })

  if (!wants) {
    return {
      ...accepted,
      state: lastAccepted === null ? 'never' : 'ok',
      detail:
        lastAccepted === fingerprint
          ? 'Server already has this session.'
          : 'Auto-push is off — use "Push now".',
    }
  }

  logInfo('Pushing session', {
    reason: options.reason,
    forced: options.forcePush,
    fingerprint: shortDigest(fingerprint),
    cookies: session.status.cookieCount,
  })

  const result = await pushSession(target, settings.serverToken, session.bundle)
  if (result.kind === 'ok') {
    return {
      state: 'ok',
      at: nowMs,
      fingerprint,
      server: target.base,
      detail: `Session accepted by the server (${options.reason}).`,
    }
  }

  const detail =
    result.kind === 'http' ? `Server rejected the session: ${result.detail}` : result.detail
  logWarn('Push failed', { reason: options.reason, detail })
  return {
    ...accepted,
    state: result.kind === 'unauthorized' ? 'unauthorized' : 'error',
    at: nowMs,
    detail,
  }
}

async function toState(settings: Settings, status: ExporterStatus): Promise<ExporterState> {
  const targetResult = settings.pushEnabled ? resolveServerTarget(settings.serverUrl) : null
  const serverOriginPattern = targetResult?.ok === true ? targetResult.target.originPattern : null
  const [serverOriginGranted, omniHostGranted] = await Promise.all([
    serverOriginPattern === null ? Promise.resolve(false) : hasOrigin(serverOriginPattern),
    hasOrigin(OMNI_HOST_PERMISSION),
  ])
  return {
    settings,
    status,
    serverUrlError: targetResult?.ok === false ? targetResult.error : null,
    serverOriginGranted,
    serverOriginPattern,
    omniHostGranted,
  }
}

export interface CycleResult {
  readonly state: ExporterState
  readonly bundle: SessionBundle | null
}

async function runOnce(options: CycleOptions): Promise<CycleResult> {
  const nowMs = Date.now()
  const [settings, previous, omniHostGranted] = await Promise.all([
    readSettings(),
    readStatus(),
    hasOrigin(OMNI_HOST_PERMISSION),
  ])

  const session = await readBrowserSession(nowMs, omniHostGranted)
  const push = await settlePush(settings, session, previous.push, options, nowMs)

  const status: ExporterStatus = {
    updatedAt: nowMs,
    session: session.status,
    push,
    pendingPush:
      settings.pushEnabled &&
      session.status.fingerprint !== null &&
      session.status.fingerprint !== push.fingerprint,
  }

  await writeStatus(status)
  paintBadge(status, settings)
  return { state: await toState(settings, status), bundle: session.bundle }
}

let queue: Promise<unknown> = Promise.resolve()

/** Run a cycle, serialised behind any cycle already in flight. */
export function runCycle(options: CycleOptions): Promise<CycleResult> {
  const next = queue.then(
    () => runOnce(options),
    () => runOnce(options),
  )
  queue = next.catch(() => undefined)
  return next
}

/** Read the cached state without touching the network. */
export async function readState(): Promise<ExporterState> {
  const [settings, status] = await Promise.all([readSettings(), readStatus()])
  return toState(settings, status)
}
