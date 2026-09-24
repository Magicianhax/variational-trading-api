# Authentication

There are no API keys. The client signs in the same way the web app does: with the
**session** your browser holds after you connect a wallet at
<https://omni.variational.io>. If you can sign in to the site, you can use this client. You
do not need a private key.

## What a session is

| piece | where it comes from | needed? |
|---|---|---|
| `vr-*` cookies | Set by the site when you sign in. HttpOnly. | **Yes. This is the credential.** Every authenticated REST call carries them. |
| JWT | `GET /api/me` returns `{ token }` for a signed-in session | **No.** `client.getMe()` fetches it from the cookies. It is used to read `address` and `exp`, and as the WebSocket `{"claims": jwt}` frame. |

So all the client needs is the cookies. In `session.json` (the `SessionBundle` format)
`token` may be an empty string; the first `getMe()` fills it in.

```json
{
  "token": "",
  "cookies": "vr-...=...; vr-...=...",
  "address": "0x...",
  "expiresAt": 1767225600000
}
```

`cookies` is what actually carries the session, and `loadSession` refuses a bundle without
it. `address`, `userAgent` and `expiresAt` (epoch milliseconds) are informational; when
`expiresAt` is missing it is read from the token's `exp`, if there is a token. The client
does not send the saved `userAgent`: the curl transport uses the Chrome User-Agent it was
tested with ([ACCESS.md](ACCESS.md)).

`loadSession(source)` and `OmniClient.fromSession(source)` accept any of: a path to a
session file, the same JSON as a string, a `SessionBundle` object, or a raw cookie header.
One pair of wrapping quotes is ignored. So `VARIATIONAL_COOKIES` may hold either a cookie
header or a session as JSON, **on one line**: `.env` takes one line per variable. The
extension's **Copy session JSON** copies exactly that one line; a pretty-printed
`session.json` belongs in a file, not in `.env`.

`pnpm session:check` and the examples look for the session in one order: a path given on
the command line, then `./session.json`, then `VARIATIONAL_COOKIES`.

Facts worth knowing:

- `GET /api/me` answers `{ token: "" }` when the cookies are missing or dead. An empty
  token means "not signed in"; check for it.
- Sessions last about **7 days** (the JWT `exp`). There is **no refresh endpoint**; when it
  runs out, get a new one the same way you got the first.
- `x-omni-auth` is **not** a request header, despite what older notes say. In the web
  app's bundle it is only read off responses: `x-omni-auth: r` marks an answer that came
  through the authenticated middleware. The credential is the cookie.

## Getting a session

Three ways, best first.

### Option 1 (recommended): the bundled extension

The repo ships a small Chrome extension, **Variational Session Exporter**, that reads the
site's session cookies from your browser and saves them as `session.json`. It sends
nothing anywhere unless you turn on its optional "Push to server" setting.

1. `pnpm build:extension`
2. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick
   `extension/dist`.
3. Sign in at <https://omni.variational.io>.
4. Click the extension icon → **Download session.json**, move it to the repo root, and run
   `pnpm session:check`.

Full guide, including every permission it asks for: [EXTENSION.md](EXTENSION.md).

### Option 2: copy the cookies from DevTools

Works with any wallet, including smart-contract wallets. Written for Chrome; other
browsers' DevTools are laid out much the same.

1. Sign in at <https://omni.variational.io>.
2. Press **F12** (or right-click → Inspect) to open DevTools.
3. Open the **Network** tab and type `api` in the filter box.
4. Click any request to `omni.variational.io/api/...`, for example `/api/portfolio` or
   `/api/me`. If the list is empty, refresh the page with DevTools open.
5. In **Headers**, scroll to **Request Headers** and copy the whole value of `cookie`.
   Right-click the value → **Copy value** is the least error-prone way.
6. Put it in `.env` in the repo root, on one line and without quotes:

   ```bash
   VARIATIONAL_COOKIES=paste-the-whole-value-here
   ```

   Or pass it straight to the client: `OmniClient.fromSession(cookieHeader)` or
   `loadSession(cookieHeader)` both accept a raw cookie header.
7. Run `pnpm session:check`.

**Why not `document.cookie` in the console?** The session cookies are **HttpOnly**: the
browser sends them with every request but deliberately hides them from page JavaScript.
`document.cookie` shows only the non-HttpOnly cookies, which never include the session.
The request headers in the Network tab show exactly what the browser sends, HttpOnly
cookies included.

**Paste the whole header; the client cleans it.** The header also contains Cloudflare
cookies (`__cf_bm`, `_cfuvid`, `cf_clearance`, any `cf_*` or `__cf*`) and analytics cookies
(`_ga*`, `_gid`, `_fbp`, `_dd_*`, `ajs_*`, `amplitude*`, `intercom-*`, `_hj*`, `mp_*`, `ph_*`
and more). `loadSession` runs every header through `cleanCookieHeader`, which drops those
and keeps the rest. The full list is in
[`src/cookie-policy.ts`](../src/cookie-policy.ts); the browser extension uses the same
file, so both ways of exporting a session give the same cookie header. That matters: Cloudflare cookies are bound to the browser and
network that earned them, and replaying them from another client turns a clean `401` into
a `403` ([ACCESS.md](ACCESS.md)). A leading `cookie:` prefix is stripped too.

**The JWT, if you want to look at it.** Not required: `getMe()` fetches it. In the DevTools
**Console** on the signed-in site:

```js
await (await fetch('/api/me')).json()
```

The `token` field is the JWT. Its payload holds your `address` and `exp`. Keep it private
like the cookies.

### Option 3 (optional, advanced): programmatic login with a private key

If you have a session, **you never need this.** It exists for unattended setups that must
mint their own session. It performs the same Sign-In-With-Ethereum handshake the web app
does, signing with the account's private key:

```bash
# in .env, or the environment:
VARIATIONAL_PRIVATE_KEY=0x...
pnpm example examples/login-with-private-key.ts   # writes ./session.json
```

```ts
import { curlTransport, mintSessionViaSiwe, OmniClient } from 'variational-trading-api'

const key = process.env['VARIATIONAL_PRIVATE_KEY']
if (key === undefined || key === '') throw new Error('set VARIATIONAL_PRIVATE_KEY')

// Dry run can stay on: login moves no money, so it is not dry-run gated.
const client = new OmniClient({ fetchImpl: curlTransport })
const session = await mintSessionViaSiwe(client, key)
// session = { token, cookies, address }: the same SessionBundle as session.json
```

Before you use it:

- **Only an EOA key works.** A smart-contract wallet (Safe, Ambire, ...) cannot produce the
  plain `personal_sign` signature the venue accepts. Use Option 1 or 2.
- **Whoever holds the key holds the funds.** The key has to be present wherever this runs.
  Keep what the account holds to what you are willing to lose on that machine.
- **Run it from a home connection.** Login from a datacenter IP is challenged by Cloudflare
  ([ACCESS.md](ACCESS.md)). Mint the session at home and carry `session.json` to the server
  instead, so the key never lives there.

The handshake, for reference:

```
POST /api/auth/generate_signing_data   { address }                       -> message
     personal_sign(message, key)
POST /api/auth/login                   { address, signed_message, ... }  -> Set-Cookie: vr-*
GET  /api/me                                                             -> { token }
```

- **The message must come from the venue.** It carries a server nonce; a locally built
  message signs perfectly and is rejected without explanation.
- **Logging in to an existing account sends no captcha token.** Cloudflare Turnstile gates
  new-account creation, not login.

The app's "sign in on another device" (QR) flow is also mapped, and its sessions carry
`scope: transfer:none`: trade-only, deposits and withdrawals disabled in the app (whether
the server enforces that is unconfirmed). Endpoints are in [API.md](API.md#session-and-auth).

## Expiry and 401s

- `pnpm session:check` shows the time left. In code, `client.decodeToken()` after
  `getMe()` gives the JWT `exp` (seconds), and `client.isTokenExpiring(withinSec)` checks it.
- **Do not call `logout()` on a 401.** It destroys a session that may still be recoverable.
- An `AuthError` (HTTP 401) is the signal to **stop sending orders** and get a new session.
  `AuthError.sessionStamped` is true when the 401 carried `x-omni-auth: r`, meaning the
  session itself is dead rather than one endpoint refusing. The web app treats three such
  401s in a row as a lost session; doing the same is reasonable.
- Mutating requests are never retried automatically. After an error mid-order, check
  `getOrders()` / `getPositions()` before trying again.

## Keeping it safe

- A session is a password for your account for up to 7 days: it can place and cancel
  orders. `session.json` and `.env` are git-ignored here; keep them that way.
- Never paste cookies, a token or a key into an issue, a chat or a screenshot.
- The client keeps credentials out of its own log lines and error messages.
- More, including how to revoke a session: [SECURITY.md](../SECURITY.md).
