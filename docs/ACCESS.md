# Reaching Variational from code

This page is about reaching **your own account** from your own code, the way the web app
does. Use this client only with your own account and in line with Variational's Terms of
Service. Do not use it to get around rate limits or access controls: if the venue refuses
a kind of client, respect that.

Three things decide whether a request from code gets an answer. This page says what each
one is and what the client does about it.

## 1. Node's own HTTP client is refused

`omni.variational.io/api/*` sits behind Cloudflare Bot Management, which looks at the
client's **TLS handshake** and **header order**, not just header values. Measured from a
home (residential) connection:

| client | headers | result |
|---|---|---|
| curl | none | 403 |
| curl | Chrome `User-Agent` | **200** |
| node `fetch` (undici) | full Chrome set | 403 |
| node `https` + Chrome cipher order | full Chrome set | 403 |

**What the client does:** `curlTransport` runs the system `curl` for every request. curl
connects as itself; nothing imitates a browser's TLS stack. Two details matter and are
pinned by tests:

- **The User-Agent goes through `--user-agent`, never `--header`.** curl appends
  `--header` values after its own defaults, so a UA passed that way lands in an unusual
  position. Same URL, same value: `--header` → 403 five times out of five;
  `--user-agent` → 200 five out of five.
- **Leave curl's default `Accept: */*` alone.** Overriding it to `application/json`
  reliably draws a challenge.

The session cookie and request bodies are passed to curl on **stdin** (`--config -`), not
on its command line, so other users on the same machine cannot read them from the
process list.

By hand, for a public endpoint:

```bash
curl -s --user-agent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36' \
  'https://omni.variational.io/api/funding/v2?underlying=BTC&instrument_type=perpetual_future' | jq
```

`CURL_BIN` points the transport at a different curl binary, for example when `curl` is
not on `PATH`.

## 2. Cloud and datacenter IPs are challenged

From a cloud server or other datacenter IP, `/api/*` answers `403` with
`cf-mitigated: challenge` (the "Just a moment…" page) for plain HTTP clients, curl
included. The separate public stats host still answers.

**Recommended setup: run the client from a home connection.** That is what the web app's
users do, and it is what this client is tested from. Datacenter use may be blocked at any
time, and that is the venue's call.

If you do run on a server, `createBrowserTransport` drives a real, visible Chromium
through Playwright and sends each request with the page's own `fetch`, so the browser
answers Cloudflare's check the way it does for any person using the site. It does not
hide that it is automated: no stealth plugins, no `navigator.webdriver` patching. You
supply the browser context (Playwright is not a dependency of this package):

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

What to know:

- **Headed, not headless.** The headless shell does not complete the check. On a server
  without a display, run it under `xvfb-run`.
- **Start on a small JSON path, not the app root.** The root loads the whole web app and
  a burst of analytics requests.
- **A check that lands on a background request cannot complete there.** The check page
  arrives as a fetch response with no document to run in, and retrying the request only
  repeats the 403. The transport detects `cf-mitigated: challenge`, loads the warm-up
  page once so the check can run, and retries the request once.
- **Don't import another machine's Cloudflare cookies.** `__cf_bm`, `_cfuvid` and
  `cf_clearance` belong to the browser and network that received them. Injecting them
  turns a clean 401 into a 403. `setBrowserCookies` passes only the venue's `vr-*`
  session cookies.
- **Start from a clean profile.** An old `__cf_bm` left in a persistent profile can make
  every request fail. `purgeNonSessionCookies` drops everything but `vr-*` at startup.

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
the transport suspends that whole class until then. Treat these as the venue asking you
to slow down, not as something to route around. The public stats host documents
10 requests / 10 s per IP.

## Signing in from a server

`/auth/login` from a datacenter IP is challenged too. Sign in from home and carry the
session over (a session is just cookies; see [AUTH.md](AUTH.md)). That has a real upside:
the wallet key never has to live on the server.
