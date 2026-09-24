# Variational Trading API

An **unofficial, reverse-engineered**, fully typed TypeScript client for
[Variational Omni](https://omni.variational.io) — the RFQ perpetuals venue on Arbitrum.

Variational publishes **no trading API and no API keys**. Everything here was mapped from
the web app's shipped JavaScript bundles and verified against the live venue: every
endpoint, exact field spellings, instrument encodings, precision rules, the WebSocket
feeds, and the three walls that stop a naive bot from connecting at all.

> **Not affiliated with Variational.** Nothing about this API is contractual; it can change
> without notice. A shape change is caught (every response is schema-validated and fails
> closed), but only you can decide what to do about it. Private repository — personal use.

## What you get

- **Every endpoint, typed** — auth, positions, portfolio, orders (market, limit, trigger,
  take-profit, stop-loss), quotes, transfers, funding, leverage, settlement pools, metadata.
- **Every response validated with zod.** A changed shape throws `SchemaDriftError` with the
  endpoint, the issues and the raw body, instead of silently misreading a position.
- **Dry run by default.** Nothing that touches money is sent until you pass `dryRun: false`.
- **Transports that actually get through Cloudflare** — `curl` for home connections, a real
  headed Chromium via Playwright for datacenter IPs. See [docs/ACCESS.md](docs/ACCESS.md).
- **Programmatic login** via Sign-In-With-Ethereum, or reuse a logged-in browser's cookies.
- **WebSocket feeds** — mark prices, unrounded quotes, and the authenticated
  events/portfolio sockets, all reconnecting.
- **Rate limiting** per endpoint class, honouring the venue's `418`/`429` bans.
- **166 pure tests** — no network, injected clocks, recorded fixtures.

## Requirements

- Node **22+**
- `curl` on the `PATH` (it is on macOS, Linux and Windows 10+)
- pnpm (recommended) or npm

## Install

```bash
git clone <this repo> variational-trading-api
cd variational-trading-api
pnpm install        # or: npm install
pnpm build
pnpm test
```

## Quick start

```ts
import { curlTransport, OmniClient } from 'variational-trading-api'

// Public data — no login.
const client = new OmniClient({ fetchImpl: curlTransport })
const funding = await client.getFunding({ symbol: 'BTC', instrument_type: 'perpetual_future' })
console.log(funding.predicted_funding_rate, 'per', funding.funding_interval_s / 3600, 'h')
```

```ts
// Logged in — cookies copied from a browser, or a session from mintSessionViaSiwe.
const client = new OmniClient({ fetchImpl: curlTransport, cookies, dryRun: false })
await client.getMe()                              // validates the session, mints the WS JWT
const positions = await client.getPositions()

const quote = await client.quoteIndicative({ instrument: { symbol: 'BTC' }, qty: '0.001' })
await client.placeMarketOrder({ quoteId: quote.quote_id, side: 'Buy', maxSlippageBps: 20 })
```

## Examples

```bash
pnpm example examples/market-data.ts   # public: config + predicted funding
pnpm example examples/prices-ws.ts     # public: live mark prices over WebSocket
pnpm example examples/login.ts         # SIWE login -> ./session.json
pnpm example examples/account.ts       # balance, positions, transfer ledger totals
pnpm example examples/trade.ts         # quote + market order (DRY RUN unless DRY_RUN=false)
```

Copy `.env.example` to `.env` for the ones that need credentials. `.env` and
`session.json` are git-ignored.

## Docs

| | |
|---|---|
| [docs/API.md](docs/API.md) | Every REST endpoint and WebSocket feed, plus the wire-format traps |
| [docs/AUTH.md](docs/AUTH.md) | How a session works: SIWE, cookies, the JWT, lifetimes |
| [docs/ACCESS.md](docs/ACCESS.md) | Cloudflare, datacenter IPs, rate limits — and the way through each |

## Layout

```
src/
  client.ts             OmniClient — every endpoint
  http.ts               cookie jar, retry policy, dry-run gate, 418/429 handling
  curl-transport.ts     gets through Cloudflare's TLS fingerprinting
  browser-transport.ts  gets through the datacenter-IP challenge (Playwright)
  session.ts, siwe.ts   programmatic login
  schemas.ts            zod schema for every response
  instrument.ts         the two instrument encodings
  precision.ts, wire.ts decimal strings, sides, signed sizes
  rate-limit.ts         per-class token buckets
  ws/                   prices, quotes, events/portfolio feeds
test/                   pure tests + recorded fixtures
examples/               runnable scripts
docs/                   the API as mapped
```

## Safety

- `dryRun` defaults to **true**. Mutating calls return a synthetic ack (or throw, with
  `dryRunMode: 'throw'`) until you opt out explicitly.
- Mutating requests are **never** auto-retried: a timed-out order may have executed.
  Reconcile against `getOrders()` / `getPositions()` instead.
- Credentials never reach a log line — the curl transport builds its error messages from
  safe parts only, because the session rides in its arguments.
- A private key used for SIWE login is a key to the account's funds. Keep what the account
  holds to what you're willing to have at risk on the machine running this.
