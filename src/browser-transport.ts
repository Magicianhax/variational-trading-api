/**
 * A `FetchLike` backed by a real Chromium instance.
 *
 * WHY THIS EXISTS
 *
 * The venue fronts `/api/*` with Cloudflare Bot Management. From a datacenter IP it
 * answers `403` with `Cf-Mitigated: challenge` -- the "Just a moment..." interstitial --
 * for any HTTP client, including the curl transport that works fine from a home
 * connection. Measured across three independent hosting IPs (two providers, one after a
 * clean OS install): all challenged, while public endpoints like `/metadata/stats` pass.
 *
 * A managed challenge is not a block. It is a test that real browsers pass and simple
 * HTTP clients fail, and it resolves itself once the challenge script executes. So this
 * transport satisfies it the intended way: by being an actual browser.
 *
 * Measured on the deployment host:
 *   headless shell, /api/me   -> stuck on "Just a moment..."
 *   headed Chromium + xvfb    -> 200, real API body
 *
 * DELIBERATELY ABSENT: any stealth plugin, any `navigator.webdriver` patching, any
 * fingerprint forgery. `navigator.webdriver` reads `true` and we are passed anyway,
 * because a genuine browser engine ran the challenge. If Cloudflare ever tightens such
 * that this stops working, the answer is NOT to start hiding what we are -- that would
 * be defeating the control rather than satisfying it. It would mean the venue does not
 * want server-side clients, and the fix would have to come from them.
 *
 * COOKIES ARE THE BROWSER'S
 *
 * In-page `fetch` cannot read `Set-Cookie` (browsers hide it from script), so
 * `getSetCookie()` returns empty and `OmniHttp`'s jar stays empty by design. That is
 * correct here rather than a gap: the browser context owns the cookie jar, persists it
 * to disk, and attaches it automatically. Session injection therefore goes through
 * `setCookies()` below, not through the client's jar.
 */
import type { FetchLike } from './http.js'

/** The slice of Playwright this needs, typed structurally so the package takes no dependency on it. */
type PageLike = {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  url(): string
}
type ContextLike = {
  pages(): PageLike[]
  newPage(): Promise<PageLike>
  addCookies(cookies: unknown[]): Promise<void>
  clearCookies(): Promise<void>
  cookies(): Promise<Array<{ name: string; value: string; domain: string; path: string }>>
  close(): Promise<void>
}

export type BrowserTransportOptions = {
  context: ContextLike
  /** Origin the page must sit on for same-origin fetches, e.g. https://omni.variational.io */
  origin: string
  /**
   * URL to navigate to when clearing a challenge or warming the jar.
   *
   * Deliberately NOT the site root. The root is a single-page app: loading it pulls the
   * bundle and fires a burst of its own XHRs and analytics, which is a far heavier and
   * noisier thing to ask Cloudflare to clear than one small JSON response. Every manual
   * probe that passed navigated to a plain API path; the transport navigated to the
   * root and was challenged on every subsequent call.
   */
  warmupUrl?: string
  /** How long an individual in-page request may take. */
  timeoutMs?: number
  /** How long to let Cloudflare's interstitial resolve before giving up. */
  challengeTimeoutMs?: number
  /** Called for every 4xx/5xx, so the caller can distinguish a challenge from a refusal. */
  onResponse?: (info: {
    method: string
    url: string
    status: number
    cfMitigated: string | null
    bodyHead: string
  }) => void
}

type WireRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}
type WireResponse = {
  status: number
  headers: Record<string, string>
  body: string
  error?: string
}

/**
 * Runs inside the page. Returns a plain object rather than a Response because only
 * structured-cloneable values survive the boundary.
 */
async function inPageFetch(req: WireRequest): Promise<WireResponse> {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      // The venue authenticates with a cookie; the browser jar supplies it.
      credentials: 'include',
      ...(req.body === null ? {} : { body: req.body }),
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })
    return { status: res.status, headers, body: await res.text() }
  } catch (err) {
    return {
      status: 0,
      headers: {},
      body: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function createBrowserTransport(options: BrowserTransportOptions): FetchLike {
  const { context, origin } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  const warmupUrl = options.warmupUrl ?? options.origin
  const challengeTimeoutMs = options.challengeTimeoutMs ?? 30_000
  const onResponse = options.onResponse

  /**
   * True while the page is sitting on Cloudflare's interstitial rather than the site.
   * Checked by content because the challenge is served AT the requested URL with a 403,
   * so the address bar still reads as the origin -- a url() check alone cannot see it.
   */
  async function onChallenge(page: PageLike): Promise<boolean> {
    // Body runs in the page, where `document` exists; this file is typechecked for Node,
    // so the global is reached through globalThis rather than a DOM lib reference.
    return page
      .evaluate(
        () => {
          const doc = (
            globalThis as { document?: { title?: string; body?: { innerText?: string } } }
          ).document
          const text = `${doc?.title ?? ''} ${doc?.body?.innerText ?? ''}`
          return /just a moment|checking your browser|performing security verification/i.test(text)
        },
        null as unknown as null,
      )
      .catch(() => false)
  }

  async function pageOnOrigin(): Promise<PageLike> {
    const existing = context.pages()
    const page = existing[0] ?? (await context.newPage())
    // Same-origin is what makes the cookie jar and the challenge clearance apply. A
    // page parked on about:blank would fetch cross-origin and be treated as such.
    const jarDirty = dirtyJars.has(context)
    if (jarDirty || !page.url().startsWith(origin) || (await onChallenge(page))) {
      await page.goto(warmupUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      dirtyJars.delete(context)
    }
    /*
     * The challenge clears itself once its script runs, but that takes seconds. Fetching
     * before then inherits the interstitial's context and the venue answers 403 -- which
     * is exactly what happened: session pushes failed with "HTTP 403" from /me while the
     * page was still on "Just a moment...".
     */
    const deadline = Date.now() + challengeTimeoutMs
    while (await onChallenge(page)) {
      if (Date.now() > deadline) {
        throw new Error(
          'browser transport: Cloudflare challenge did not clear within ' +
            `${challengeTimeoutMs}ms -- the venue is not accepting this browser`,
        )
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return page
  }

  return async function browserFetch(url: string, init: RequestInit): Promise<Response> {
    const page = await pageOnOrigin()
    const headers: Record<string, string> = {}
    const raw = init.headers
    if (raw !== undefined) {
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const k = entry[0]
          if (typeof k === 'string') headers[k] = String(entry[1])
        }
      } else if (typeof (raw as Headers).forEach === 'function')
        (raw as Headers).forEach((v, k) => {
          headers[k] = v
        })
      else Object.assign(headers, raw as Record<string, string>)
    }
    // The browser sets these itself and refuses script attempts to override them.
    for (const forbidden of ['user-agent', 'cookie', 'host', 'origin', 'referer']) {
      delete headers[forbidden]
      delete headers[forbidden.toUpperCase()]
    }

    const body = typeof init.body === 'string' ? init.body : null
    const request = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      body,
    }

    let out = await page.evaluate(inPageFetch, request)

    /*
     * An XHR can be challenged on its own while the PAGE stays perfectly clear -- the
     * challenge HTML arrives in the fetch response and there is no document for its
     * script to run in. Retrying the XHR can therefore never clear it, which is exactly
     * how this deployment ended up in a 403 storm: every retry was another XHR that
     * could not possibly succeed.
     *
     * A challenge is cleared by a NAVIGATION. So when we see one, navigate the page --
     * which lets the challenge run and resolve as intended -- and try the request once
     * more. This is the recovery path the transport was missing.
     */
    if (out.status === 403 && /challenge/i.test(out.headers['cf-mitigated'] ?? '')) {
      onResponse?.({
        method: request.method,
        url,
        status: out.status,
        cfMitigated: out.headers['cf-mitigated'] ?? null,
        bodyHead: 'challenged XHR; re-navigating to clear',
      })
      await page.goto(warmupUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      const deadline = Date.now() + challengeTimeoutMs
      while (await onChallenge(page)) {
        if (Date.now() > deadline) break
        await new Promise((r) => setTimeout(r, 500))
      }
      out = await page.evaluate(inPageFetch, request)
    }

    /*
     * A non-2xx here is worth its own line. The venue sits behind Cloudflare, so the
     * difference between an application refusal and a bot challenge is the whole
     * diagnosis, and "HTTP 403" alone cannot tell them apart -- cf-mitigated can.
     */
    if (out.status >= 400 && onResponse !== undefined) {
      onResponse({
        method: (init.method ?? 'GET').toUpperCase(),
        url,
        status: out.status,
        cfMitigated: out.headers['cf-mitigated'] ?? null,
        bodyHead: out.body.slice(0, 160),
      })
    }

    if (out.status === 0) {
      throw new Error(
        `browser transport failed (${init.method ?? 'GET'} ${url}): ${out.error ?? 'unknown'}`,
      )
    }

    const responseHeaders = new Headers(out.headers)
    // Script cannot see Set-Cookie; the context jar already holds it.
    Object.defineProperty(responseHeaders, 'getSetCookie', { value: () => [] as string[] })
    return new Response(out.body, { status: out.status, headers: responseHeaders })
  }
}

/**
 * Cookies that belong to Cloudflare's bot management rather than the venue.
 *
 * `__cf_bm` and `_cfuvid` are bound to the client and network that earned them, and
 * `cf_clearance` likewise. A session captured in someone's desktop browser carries
 * THAT browser's tokens — injecting those here hands this
 * browser bot-management state that does not describe it, and Cloudflare answers with a
 * challenge. Observed exactly that: unauthenticated /positions returned a clean 401,
 * and the first call after injecting the session returned 403.
 *
 * This browser earns its own. Only the venue's session cookies cross over.
 */
const CLOUDFLARE_COOKIES = /^(__cf_bm|_cfuvid|cf_clearance|__cflb|__cfwaitingroom)$/i

/**
 * Drop every cookie except the venue's own session, and let the browser re-earn its
 * Cloudflare state.
 *
 * A persistent profile accumulates `__cf_bm` (Cloudflare's bot-management token, bound
 * to the client and network that earned it) alongside analytics cookies. A stale one
 * marks the browser as suspicious on EVERY request -- measured on this deployment: with
 * the accumulated jar, even a plain navigation to /metadata/config returned 403 and the
 * challenge never cleared in 20s; after purging everything but the `vr-*` cookies the
 * same navigation returned 200 and an authenticated /api/positions returned real data.
 *
 * Call this before use and after injecting a session.
 */
export async function purgeNonSessionCookies(context: ContextLike): Promise<void> {
  const jar = await context.cookies()
  const keep = jar.filter((c) => /^vr-/.test(c.name))
  await context.clearCookies()
  if (keep.length > 0) await context.addCookies(keep)
  /*
   * The jar now has NO Cloudflare state, and an XHR sent in that condition is the exact
   * profile a managed challenge exists to catch: datacenter IP, script-initiated fetch,
   * valid session, zero bot-management history. A navigation re-earns __cf_bm; a fetch
   * cannot. So mark the jar dirty and let pageOnOrigin() navigate before anything else
   * goes out -- the successful manual test purged AND navigated, and only the
   * navigation made it work.
   */
  dirtyJars.add(context)
}

/** Contexts whose cookies were cleared and which must navigate before their next fetch. */
const dirtyJars = new WeakSet<object>()

/** Inject a venue session into the browser's cookie jar. */
export async function setBrowserCookies(
  context: ContextLike,
  cookieHeader: string,
  domain: string,
): Promise<void> {
  const cookies = cookieHeader
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
    .filter((p) => !CLOUDFLARE_COOKIES.test(p.slice(0, p.indexOf('=')).trim()))
    .map((p) => {
      const idx = p.indexOf('=')
      return {
        name: p.slice(0, idx).trim(),
        value: p.slice(idx + 1).trim(),
        domain,
        path: '/',
        secure: true,
        sameSite: 'Lax' as const,
      }
    })
  if (cookies.length > 0) await context.addCookies(cookies)
}
