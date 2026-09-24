# Authentication

There are no API keys. A session is what the web app has after you connect a wallet:
**HttpOnly cookies** set by a Sign-In-With-Ethereum handshake, plus a JWT.

## What a session is

| piece | where it comes from | what it's for |
|---|---|---|
| `vr-*` cookies | set by `POST /auth/login` | **The actual credential.** Every authenticated REST call. |
| JWT | `GET /me` → `{ token }` | Decoding `address`, `exp`, `scope`; the WebSocket `{"claims": jwt}` frame |

`x-omni-auth` is **not** a request header, despite what older notes say. In the bundle it
is only ever read *off responses*: `x-omni-auth: r` marks an answer that came through the
authenticated middleware. The credential is the cookie.

`GET /me` returns `{ token: "" }` when you are not logged in — check for the empty string.

Sessions last about **7 days** (the JWT `exp`). There is no refresh endpoint; log in again.

## Option A — programmatic login (EOA key)

```ts
import { curlTransport, mintSessionViaSiwe, OmniClient } from 'variational-trading-api'

const client = new OmniClient({ fetchImpl: curlTransport })
const session = await mintSessionViaSiwe(client, process.env.VARIATIONAL_PRIVATE_KEY!)
// session = { token, cookies, address, expiresAt }
```

The handshake:

```
POST /auth/generate_signing_data   { address }                       -> message
     personal_sign(message, key)
POST /auth/login                   { address, signed_message, ... }  -> Set-Cookie: vr-*
GET  /me                                                             -> { token }
```

Three facts that cost time:

- **The message must come from the venue.** It carries a server nonce; a locally
  synthesised message signs perfectly and is rejected without explanation.
- **An existing account's login sends no captcha token.** Cloudflare Turnstile gates
  new-account creation, not login.
- **Only an EOA can do this.** A smart-contract wallet (Ambire, Safe, …) can't produce a
  plain `personal_sign` signature the venue accepts. Use Option B.

Run it from a home connection; login from a datacenter IP is challenged
([ACCESS.md](ACCESS.md)).

## Option B — reuse a logged-in browser

Log in at `omni.variational.io` normally, then copy the session cookies (DevTools →
Application → Cookies, the `vr-*` ones) into a `document.cookie`-style string:

```ts
const client = new OmniClient({ fetchImpl: curlTransport, cookies: 'vr-token=...; vr-...=...' })
await client.getMe()
```

Works with any wallet, including smart-contract ones. Copy only `vr-*` cookies — never
the Cloudflare ones (`__cf_bm`, `_cfuvid`, `cf_clearance`), which are bound to the
browser that earned them.

## Option C — the cross-device transfer flow (QR sign-in)

The app's "sign in on another device" flow is also mapped:

```
POST /auth/issue_transfer_init_code
GET  /auth/transfer_init_status?init_id=
POST /auth/issue_transfer_token    { address, signed_message, init_code }
POST /auth/transfer_token_status   { token }
POST /auth/redeem_transfer_token   { transfer_token, init_id }
```

A redeemed session carries `scope: transfer:none` — **trade-only, deposits and
withdrawals disabled** — which is exactly what you want on an unattended machine.
(Unconfirmed whether that scope is enforced server-side or only in the UI.)

## Handling expiry and 401s

- Read the expiry from the JWT (`client.decodeToken(token)`) and log in again before it.
- **Do not call `logout` on a 401.** It destroys a session that may still be recoverable.
- The web app treats three consecutive 401s as a lost session and logs out; do the same.
  `AuthError` is your signal to stop sending orders and get a new session.

## Keeping it safe

- A session bundle is a password. `session.json` and `.env` are git-ignored here.
- A private key used for SIWE can move funds. Keep the account's balance to what you're
  willing to risk on the machine holding it — or use Option B/C and keep the key off it.
