# Variational Trading API

An **unofficial, reverse-engineered**, fully typed TypeScript client for
[Variational Omni](https://omni.variational.io), the RFQ perpetuals venue on Arbitrum.

Variational publishes **no trading API and no API keys**. Everything here was mapped from
the web app's shipped JavaScript bundles and checked against the live venue: the
endpoints, exact field spellings, instrument encodings, precision rules, the WebSocket
feeds, and the three walls that stop a naive bot from connecting at all.

> **Disclaimer.** Not affiliated with, endorsed by or supported by Variational. Nothing
> about this API is contractual and it can change without notice. Every response is
> schema-validated and fails closed, so a shape change is caught, but only you can decide
> what to do about it. Trading carries risk; you are responsible for what your code sends.

## What you get

- **Every endpoint, typed**: auth, positions, portfolio, orders (market, limit, trigger,
  take-profit, stop-loss), quotes, transfers, funding, leverage, settlement pools, metadata.
- **Every response validated with zod.** A changed shape throws `SchemaDriftError` with the
  endpoint, the issues and the raw body, instead of silently misreading a position.
- **Dry run by default.** Nothing that touches money is sent until you pass `dryRun: false`.
- **Sign in with a browser session, no private key.** A bundled browser extension exports
  your logged-in session to `session.json`; `OmniClient.fromSession()` loads it.
- **Transports that get through Cloudflare**: `curl` for home connections, a real headed
  Chromium via Playwright for datacenter IPs. See [docs/ACCESS.md](docs/ACCESS.md).
- **WebSocket feeds**: mark prices, unrounded quotes, and the authenticated
  events/portfolio sockets, all reconnecting.
- **Rate limiting** per endpoint class, honouring the venue's `418`/`429` bans.
- **Pure tests**: no network, injected clocks, recorded fixtures.

## Requirements

- Node **22 or newer**
- pnpm (recommended) or npm
- `curl` on the `PATH` (it ships with macOS, Linux and Windows 10+)
- A Variational Omni account you can sign in to at <https://omni.variational.io>
- Chrome 116+, Edge, Brave or another Chromium browser, if you use the bundled extension

## Quick start

**1. Clone, install, build.**

```bash
git clone <this repo> variational-trading-api
cd variational-trading-api
pnpm install        # or: npm install
pnpm build
```

**2. Get a session.** A session is the site's own login cookies. You do not need a
private key. Pick one:

- **The bundled extension (recommended).**
  1. `pnpm build:extension`
  2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
     pick the `extension/dist` folder.
  3. Sign in at <https://omni.variational.io> as usual.
  4. Click the extension's toolbar icon, then **Download session.json**, and move the file
     into the repo root.

  Details, permissions and privacy: [docs/EXTENSION.md](docs/EXTENSION.md).
- **Copy the cookies by hand** from the browser's DevTools and put them in `.env` as
  `VARIATIONAL_COOKIES=...`. Step by step: [docs/AUTH.md](docs/AUTH.md#option-2-copy-the-cookies-from-devtools).

**3. Check the session.**

```bash
pnpm session:check                 # reads ./session.json, else VARIATIONAL_COOKIES
pnpm session:check path/to/other.json
```

It prints the signed-in address, when the session expires and how long is left, and
exits non-zero with a message saying what to do if the session is missing, expired or
rejected. It never prints cookie or token values.

**4. Run the examples.**

```bash
pnpm example examples/market-data.ts             # public: config + predicted funding, no session
pnpm example examples/prices-ws.ts               # public: live mark prices over WebSocket for 15 s
pnpm example examples/account.ts                 # balance, positions, transfer-ledger totals
pnpm example examples/trade.ts                   # quote + market order, DRY RUN unless DRY_RUN=false
pnpm example examples/login-with-private-key.ts  # optional, advanced: SIWE login with an EOA key
```

## Using the client

```ts
import { OmniClient } from 'variational-trading-api'

// session.json from the extension, a path, a JSON string, or a raw "Cookie:" header.
// Uses the curl transport and stays in dry run unless you say otherwise.
const client = OmniClient.fromSession('session.json')

const me = await client.getMe()           // validates the session, fetches the WebSocket JWT
if (me.token === '') throw new Error('session expired: export a new one')

const positions = await client.getPositions()
const portfolio = await client.getPortfolio()

const quote = await client.quoteIndicative({ instrument: { symbol: 'BTC' }, qty: '0.001' })
const ack = await client.placeMarketOrder({ quoteId: quote.quote_id, side: 'Buy', maxSlippageBps: 20 })
// ack is synthetic: dry run is on, nothing was sent.
```

To trade for real, opt in explicitly: `OmniClient.fromSession('session.json', { dryRun: false })`.

Public market data needs no session at all:

```ts
import { curlTransport, OmniClient } from 'variational-trading-api'

const client = new OmniClient({ fetchImpl: curlTransport })
const funding = await client.getFunding({ symbol: 'BTC', instrument_type: 'perpetual_future' })
```

The package is not published to npm. Inside this repo, import from `./dist/index.js` as
the examples do. From another project on the same machine, build this one and add it with
`pnpm add link:../variational-trading-api`.

## Dry run

`dryRun` defaults to **true** in the client and in every example.

- A mutating call (orders, cancels, leverage, margin mode, logout) returns a synthetic ack
  and sends nothing. Pass `dryRunMode: 'throw'` to get a `DryRunViolation` instead.
- Reads and quotes are not gated: minting a quote does not trade.
- The examples read `DRY_RUN` from the environment or `.env`. Anything other than an
  explicit `false` means dry run.
- Mutating requests are **never** retried automatically, because a timed-out order may
  have executed. Reconcile against `getOrders()` / `getPositions()` instead.

## Configuration

Copy `.env.example` to `.env`. Every variable is optional.

| variable | what it is |
|---|---|
| `VARIATIONAL_COOKIES` | A session as a cookie header copied from the browser. Used when there is no `session.json`. |
| `DRY_RUN` | `true` by default. Only the exact value `false` sends real orders. |
| `VARIATIONAL_PRIVATE_KEY` | Optional, advanced. Only for `examples/login-with-private-key.ts`. You do not need it if you have a session. |
| `CURL_BIN` | Path to an alternative curl, for example a `curl-impersonate` build ([ACCESS.md](docs/ACCESS.md)). Read when the library loads, so set it in the real environment, not `.env`. |

## Docs

| | |
|---|---|
| [docs/AUTH.md](docs/AUTH.md) | What a session is, three ways to get one, expiry and 401 handling |
| [docs/EXTENSION.md](docs/EXTENSION.md) | The session-exporter extension: install, buttons, permissions, privacy |
| [docs/API.md](docs/API.md) | Every REST endpoint and WebSocket feed, plus the wire-format traps |
| [docs/ACCESS.md](docs/ACCESS.md) | Cloudflare, datacenter IPs, rate limits, and the way through each |
| [SECURITY.md](SECURITY.md) | Handling sessions and keys, revoking them, reporting a vulnerability |

## Troubleshooting

- **`403` on every request.** Cloudflare. From a home connection the curl transport gets
  through; from a cloud server or other datacenter IP it will not, and you need the
  browser transport. See [docs/ACCESS.md](docs/ACCESS.md).
- **`me.token` is empty, or you get `AuthError`.** The session expired (they last about
  7 days) or was signed out. Export a new one. Do not call `logout()` in response.
- **`SchemaDriftError`.** The venue changed a response shape. The error carries the
  endpoint and the raw body; please open an issue with the endpoint and the zod issues,
  with any account data removed.

## Layout

```
src/
  client.ts             OmniClient: every endpoint
  session-io.ts         loadSession, cleanCookieHeader: read a session from anywhere
  session-bundle.ts     the SessionBundle type (the session.json format)
  http.ts               cookie jar, retry policy, dry-run gate, 418/429 handling
  curl-transport.ts     gets through Cloudflare's TLS fingerprinting
  browser-transport.ts  gets through the datacenter-IP challenge (Playwright)
  session.ts, siwe.ts   optional programmatic login with a private key
  schemas.ts            zod schema for every response
  instrument.ts         the two instrument encodings
  precision.ts, wire.ts decimal strings, sides, signed sizes
  rate-limit.ts         per-class token buckets
  ws/                   prices, quotes, events/portfolio feeds
extension/              Variational Session Exporter (Chrome MV3); builds to extension/dist
scripts/
  session-check.ts      pnpm session:check
  smoke.ts              pnpm smoke: live check of public endpoints only
examples/               runnable scripts
test/                   pure tests + recorded fixtures
docs/                   the API as mapped
```

## Development

```bash
pnpm typecheck        # client, tests, scripts, examples, then the extension
pnpm test             # one vitest run over the client and the extension; pure, no network
pnpm test:extension   # the extension's tests only
pnpm lint             # Biome, whole repo
pnpm build:extension  # extension/dist
pnpm smoke            # live, public endpoints only, dry run; not part of CI
```

## Security

A session is a password and a private key is the funds. `.env` and `session.json` are
git-ignored; never commit them or paste them into an issue. Read [SECURITY.md](SECURITY.md)
before running anything with `dryRun: false`.

## License

All rights reserved; see [LICENSE](LICENSE). No license is granted to copy, modify or
distribute this code. The owner may change the license if the repository is made public.
