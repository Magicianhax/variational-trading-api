# Reaching Variational from code

Three things stop a bot before it sends a single order. Each has a way through, and the
client ships it.

## 1. Cloudflare fingerprints TLS — Node cannot connect at all

`omni.variational.io/api/*` sits behind Cloudflare Bot Management, which scores the
**TLS/JA3 fingerprint** and **header order**, not just header values. Measured from a
residential IP:

| client | headers | result |
|---|---|---|
| curl | none | 403 |
| curl | Chrome `User-Agent` | **200** |
| node `fetch` (undici) | full Chrome set | 403 |
| node `https` + Chrome cipher order | full Chrome set | 403 |

**Way through:** `curlTransport` shells out to the system `curl` for every request.

Two rules are load-bearing, and pinned by tests:

- **The User-Agent goes through `--user-agent`, never `--header`.** curl appends
  `--header` values after its own defaults, which puts the UA where no browser puts it.
  Same URL, same value: `--header` → 403 five times out of five; `--user-agent` → 200
  five out of five.
- **Leave curl's default `Accept: */*` alone.** Overriding it to `application/json`
  reliably draws a challenge.

By hand:

```bash
curl -s --user-agent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36' \
  'https://omni.variational.io/api/funding/v2?underlying=BTC&instrument_type=perpetual_future' | jq
```

If Cloudflare tightens further, point `CURL_BIN` at a `curl-impersonate` build — the
argument construction is compatible.

## 2. Datacenter IPs are challenged even with curl

From a cloud/VPS IP, `/api/*` answers `403` with `cf-mitigated: challenge` (the "Just a
moment…" interstitial) for **every** plain HTTP client, curl included. Reproduced across
several hosting IPs and providers. The separate public stats host still answers.

A managed challenge is not a block — it's a test a real browser passes by running a
script. **Way through:** `createBrowserTransport` drives a real Chromium through
Playwright and runs the venue's own `fetch` inside the page. You supply the browser
context (Playwright is not a dependency of this package):

```ts
import { chromium } from 'playwright'
import {
  createBrowserTransport,
  loadSession,
  OmniClient,
  purgeNonSessionCookies,
  setBrowserCookies,
} from 'variational-trading-api'

// session.json from the extension (or a raw Cookie header); see AUTH.md.
const { cookies = '' } = loadSession('session.json')

const ctx = await chromium.launchPersistentContext('.browser-profile', { headless: false })
await purgeNonSessionCookies(ctx)
const fetchImpl = createBrowserTransport({
  context: ctx,
  origin: 'https://omni.variational.io',
  warmupUrl: 'https://omni.variational.io/api/metadata/config',
})
await setBrowserCookies(ctx, cookies, 'omni.variational.io')
const client = new OmniClient({ fetchImpl, cookies })
```

What decides whether it works:

- **Headed, not headless.** The headless shell is still challenged; the full browser is
  not. On a server, run it under `xvfb-run`.
- **Warm up on a small JSON path, not the app root.** The root pulls the whole bundle and
  a burst of analytics requests — much more to clear.
- **A challenged XHR can never clear itself.** The challenge HTML lands in a fetch
  response with no document to run in; retrying just produces a 403 storm. A challenge
  is cleared by a **navigation**. The transport detects `cf-mitigated: challenge`,
  navigates, waits, and retries once.
- **Don't import another machine's Cloudflare cookies.** `__cf_bm`, `_cfuvid` and
  `cf_clearance` are bound to the client and network that earned them — injecting them
  turns a clean 401 into a 403. `setBrowserCookies` passes only the venue's `vr-*`
  session cookies.
- **A stale profile is poison.** An old `__cf_bm` can mark the browser suspicious on every
  request. `purgeNonSessionCookies` drops everything but `vr-*` at startup.
- No stealth plugins, no `navigator.webdriver` forgery. It passes as itself.

## 3. Rate limits are unpublished; 418 is the tell

Nothing is documented for `/api`. `RateLimiter` applies a conservative per-class token
bucket so a burst of position polls can't eat the budget an emergency close needs:

| class | budget |
|---|---|
| `order` | 6 / 10 s, burst 3 |
| `read` | 20 / 10 s |
| `quote` | 30 / 10 s |
| `meta`, `auth` | 6 / 60 s |

A **418** ("temporarily banned from orders") or **429** carries `{ wait_until_seconds }`;
the transport suspends that whole class until then. The public stats host documents
10 requests / 10 s per IP.

## Login is also challenged from datacenters

`/auth/login` from a datacenter IP is challenged too. Log in somewhere residential and
carry the session over (a session is just cookies + a JWT; see [AUTH.md](AUTH.md)). That
has a real upside: the wallet key never has to live on the server.
