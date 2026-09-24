# Variational Session Exporter (browser extension)

A small Manifest V3 extension for Chrome 116+ and other Chromium browsers (Edge, Brave, ...).
It turns the session you already have in your browser into a `session.json` this client can
load, so you never have to handle a private key or dig through DevTools.

Source: [`extension/`](../extension). Package name `variational-session-exporter`.

## What it does

When you open its popup (or press **Re-check**), it:

1. Reads the cookies your browser holds for `https://omni.variational.io/api/`, the same
   ones the site sends with every API request, including the HttpOnly `vr-*` session
   cookies that page JavaScript cannot see.
2. Drops Cloudflare cookies (`__cf*`, `_cfuvid`, `cf_*`) and analytics cookies (`_ga*`,
   `_dd_*`, `intercom-*`, `mp_*`, ...), which are not part of the session. The popup lists
   what it dropped.
3. Calls `GET https://omni.variational.io/api/me` and keeps only its `token` field (the
   JWT), which says whether you are signed in, as which address, and until when.
4. Shows the address, expiry and number of session cookies, and enables the export
   buttons. The export is a `SessionBundle`, the `session.json` format.

## What it does not do

- It reads no other site's cookies and calls no `omni.variational.io` endpoint other than
  `GET /api/me`. It never reads positions, balances, orders or page content, and it has
  no content script.
- It does not place orders, sign anything, or touch your wallet.
- **It sends nothing anywhere** unless you turn on the optional
  [Push to server](#optional-push-to-server). Copy and Download stay on your machine.
- With Push off (the default) it does nothing in the background; the session is read only
  while the popup is open.
- No analytics, no telemetry, no remote code.

## Build and install

```bash
pnpm install
pnpm build:extension        # writes extension/dist
```

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/dist` folder.
4. Optional: pin it from the puzzle-piece menu so the icon stays in the toolbar.

It is not on the Chrome Web Store; loading it unpacked is the intended way.

## Using it

Sign in at <https://omni.variational.io> as usual, then click the extension icon.

| button | what happens |
|---|---|
| **Copy session JSON** | Puts the `session.json` contents on your clipboard. Paste them into a file, or into `VARIATIONAL_COOKIES` in `.env` (it accepts a whole session as JSON). |
| **Download session.json** | Saves the same JSON as `session.json` through the browser's normal download. Move it into the repo root, then run `pnpm session:check`. If a `session.json` is already in your Downloads folder the browser may rename the new one (`session (1).json`); rename it back. |
| **Re-check** | Reads the cookies and `/api/me` again, for example after you sign in. |

The export buttons stay disabled while there is nothing to export: you are signed out,
the session has expired, or Cloudflare challenged the `/api/me` check. Open
<https://omni.variational.io> (the popup links to it), sign in, and press **Re-check**.
Sessions last about 7 days; export a fresh one when `pnpm session:check` says time is
running out.

Both buttons put a live credential on disk or on the clipboard. Clear the clipboard after
pasting, and do not leave copies of `session.json` in your Downloads folder.

## The session.json format

The `SessionBundle` type in [`src/session-bundle.ts`](../src/session-bundle.ts):

```json
{
  "token": "eyJ...",
  "cookies": "vr-...=...; vr-...=...",
  "address": "0x...",
  "expiresAt": 1767225600000
}
```

| field | meaning |
|---|---|
| `token` | The JWT from `GET /api/me`. Optional in practice: `getMe()` fetches a fresh one from the cookies. |
| `cookies` | The session, as a cookie header string. This is the credential. |
| `address` | The signed-in address, from the JWT. |
| `userAgent` | Part of the format, but the extension never fills it in and the client does not send it. |
| `expiresAt` | Epoch milliseconds, from the JWT `exp`. |

Load it with `OmniClient.fromSession('session.json')` or `loadSession('session.json')`. See
[AUTH.md](AUTH.md) for what each piece is for.

## Optional: Push to server

For people who run their own long-lived service and would rather not copy files around.
**Off by default.** Leave it off if you only use `session.json`.

In the popup's **Push to server** card, tick **Send the session to my own server** and
fill in:

- **Server URL**: the base URL of your server, for example `https://bot.example.com`. It
  must be `https://`; plain `http://` is accepted only for `localhost` and `127.0.0.1`.
  URLs with embedded credentials, a query string or a fragment are refused.
- **Bearer token**: a secret your server checks. It is sent as a header, never in the URL.
- **Push automatically when the session changes** (on by default) and **Re-check every
  (minutes)** (default 5, 1 to 360).

Press **Save**. The first time, Chrome shows its own permission prompt for that one server
origin. If you decline it, or later remove the permission, the popup shows a **Grant
access** button to ask again. **Push now** sends the current session immediately.

Each push is exactly one request:

```http
POST {url}/session
Authorization: Bearer <token>
Content-Type: application/json

{ "token": "...", "cookies": "...", "address": "0x...", "expiresAt": 1767225600000 }
```

The body is the same `SessionBundle` as `session.json`, so your server can pass it straight
to `OmniClient.fromSession(body)`. The request carries no browser cookies of its own.

What your server should answer:

- any `2xx`: accepted;
- `401` or `403`: the bearer token was refused;
- a JSON body `{ "ok": false, "error": "..." }`: rejected, and the popup shows your
  `error` text (useful for "wrong account").

While Push is on, the extension also works in the background: it re-checks the session
every *N* minutes and a few seconds after any of the site's cookies change, and with
auto-push on it pushes only when the session actually differs from the last one your
server accepted. It never pushes a signed-out or expired session. Turn Push off and the
background checks stop.

Check the bearer token on every request, and never log the request body: it is a live
session.

## Permissions

Every permission the extension asks for, and why:

| permission | why |
|---|---|
| `cookies` | The session is an HttpOnly cookie. Only the cookies API can read it; page JavaScript cannot. |
| host `https://omni.variational.io/*` | Scopes the cookie access to this one site and lets the extension call `GET /api/me`. With no other host granted, no other site's cookies are readable. |
| `storage` | Keeps the Push to server settings and the last status in `chrome.storage.local`, on this device only. Never `storage.sync`, which would copy the bearer token to every browser signed in to your Google account. |
| `alarms` | Runs the periodic re-check while Push is on. A Manifest V3 background worker is stopped when idle, and alarms are the only way to wake it on a schedule. Unused while Push is off. |
| optional: your server's origin | Requested only when you save a Push server URL, and only for that host. Never granted if you do not use Push. |

Not requested: `tabs`, `scripting`, `webRequest`, `downloads` (the file is saved through
an ordinary download link), `history`, `<all_urls>`, and no content scripts.

The authoritative list is `extension/dist/manifest.json` after a build (or
`chrome://extensions` → the extension → **Details**). If it ever disagrees with this table,
the manifest is right and this table is a bug; please report it.

## Updating

After pulling changes:

```bash
pnpm build:extension
```

Then open `chrome://extensions` and press the reload icon on the extension's card. Chrome
keeps loading `extension/dist` from disk, so there is nothing to reinstall. Your Push to
server settings survive a reload; they are lost if you remove the extension.

## Privacy

- The only data the extension handles is your own Variational session: the site's cookies
  and the `/api/me` token. Analytics and Cloudflare cookies are dropped before export.
- Nothing leaves your browser except through Copy, Download, or a Push you configured
  yourself, to the server you named.
- The Push token is stored in `chrome.storage.local`, never synced to other devices.
- To remove everything the extension stored, remove the extension from `chrome://extensions`.

Treat what it exports like a password: see [SECURITY.md](../SECURITY.md).
