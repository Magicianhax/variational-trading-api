# Security

This client acts as you on a venue that holds your money. Read this before you run
anything with `dryRun: false`.

## What counts as a credential

| thing | what it can do | how long |
|---|---|---|
| A **session**: `session.json`, the `VARIATIONAL_COOKIES` value, the `vr-*` cookies | Everything the web app can do while signed in, including placing and cancelling orders | About 7 days |
| The **JWT** (`token`) | Authenticates the WebSocket feeds; also reveals your address | Same as the session |
| A **private key** (`VARIATIONAL_PRIVATE_KEY`) | Signs in as you, and controls the wallet and every fund in it | Forever, until you stop using that wallet |

Treat a session like a password and a private key like the money itself. You do not need a
private key to use this client; see [docs/AUTH.md](docs/AUTH.md).

## Keeping them out of places they should not be

- `.env`, `.env.*` (except `.env.example`), `session.json` and `*.session.json` are in
  `.gitignore`. Keep them there, and check `git status` before every commit.
- **Never paste** a session, cookie header, token or key into a GitHub issue, pull request,
  discussion, chat or screenshot. When reporting a bug, `pnpm session:check` output is safe
  to share: it never prints cookie or token values. A `SchemaDriftError` body may contain
  account data; remove it first.
- The client keeps credentials out of its log lines and error messages. If you ever see
  one printed, that is a bug: report it privately (below).
- Do not leave exported copies in your Downloads folder or on the clipboard.
- On a server, keep `session.json` readable only by the user that runs your code.

## If a session leaks

1. **Sign out** at <https://omni.variational.io>. The web app's sign-out calls the venue's
   logout endpoint for that session.
2. Assume the leaked copy **may keep working until it expires** (about 7 days). This
   project has not verified that signing out invalidates every copy of the cookies
   server-side.
3. Watch the account (open orders, positions) until then, and sign in again to get a
   fresh session for your own use.

## If a private key leaks

Move the funds to a new wallet you control, immediately. Signing out does not help: the
key can sign in again and controls the wallet itself.

## Dry run is the default

- `dryRun` defaults to `true`. Every mutating call returns a synthetic ack and sends
  nothing until you pass `dryRun: false` yourself.
- The examples read `DRY_RUN`; anything other than the exact value `false` means dry run.
- Mutating requests are never retried automatically, so a timeout never turns into a
  duplicate order. Reconcile against `getOrders()` / `getPositions()` after an error.
- Start real trading with the smallest size the venue accepts
  (`getConfig().min_order_notional`).

## The browser extension

The bundled extension reads only `omni.variational.io` cookies and `GET /api/me`, and sends
nothing anywhere unless you configure its optional Push to server. Permissions and privacy:
[docs/EXTENSION.md](docs/EXTENSION.md).

## Reporting a vulnerability

Please report security problems **privately** to the repository owner, not in a public
issue. If the repository has GitHub private vulnerability reporting enabled, use the
**Security** tab → **Report a vulnerability**; otherwise contact the owner privately through
their GitHub profile first and ask where to send details.

Include what you found, how to reproduce it, and what it exposes. Do not include real
sessions, keys or account data. This is a personal, unofficial project: there is no bug
bounty and no guaranteed response time.

Problems with Variational itself (the venue, its website or its API) belong with
Variational, not here.
