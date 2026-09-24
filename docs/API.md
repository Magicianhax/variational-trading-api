# Variational Omni API reference (unofficial)

Mapped from the web app's shipped SvelteKit bundles and verified against the live venue.
Nothing here is contractual. The client method for each endpoint is in the last column.

## Hosts

| purpose | URL |
|---|---|
| Client API | `https://omni.variational.io/api` — behind Cloudflare, see [ACCESS.md](ACCESS.md) |
| Public stats | `https://omni-client-api.prod.ap-northeast-1.variational.io` — serves only `/metadata/stats` |
| WebSocket | `wss://omni-ws-server.prod.ap-northeast-1.variational.io` |

Errors come back as JSON with `message` or `error_message`, and structured failures add
an `error_code` (e.g. `skewLimitExceeded`, `oiLimitExceeded`). HTTP 429/418 = rate limited.

## Public (no session)

| method | path | client |
|---|---|---|
| GET | `/metadata/config` | `getConfig()` — min/max order notional, precision rules, transfer fee |
| GET | `/metadata/supported_assets` | `getSupportedAssets()`, `getAssetIndex()` |
| GET | `/metadata/stats` | `getStats(viaPublicHost?)` |
| GET | `/metadata/tiers` | `getTiers()` |
| GET | `/metadata/v2/risk_limits` | `getRiskLimits(instrument)` |
| GET | `/metadata/v2/open_interest` | `getOpenInterest(instrument)` |
| GET | `/funding/v2` | `getFunding(instrument)` |
| GET | `/ff` | `getFeatureFlags()` |
| POST | `/quotes/simple` | `quoteSimple({ instrument, qty })` |

`min_order_notional` is **0.1 USDC** — a full live test of an order path costs ten cents.

## Session and auth

See [AUTH.md](AUTH.md) for the flow.

| method | path | client |
|---|---|---|
| GET | `/me` | `getMe()` → `{ token }` (empty string when logged out) |
| POST | `/auth/generate_signing_data` | `generateSigningData(address)` |
| POST | `/auth/login` | `login({ address, signedMessage })` |
| POST | `/auth/logout` | `logout(address)` — never automatically on a 401 |
| POST | `/auth/switch` | `switchAddress(...)` |
| POST | `/auth/issue_transfer_init_code` | `issueTransferInitCode()` |
| GET | `/auth/transfer_init_status` | `getTransferInitStatus(initId)` |
| POST | `/auth/issue_transfer_token` | `issueTransferToken(...)` |
| POST | `/auth/transfer_token_status` | `getTransferTokenStatus(...)` |
| POST | `/auth/redeem_transfer_token` | `redeemTransferToken(...)` |

## Account

| method | path | client |
|---|---|---|
| GET | `/portfolio?compute_margin=true` | `getPortfolio()` — `balance`, `upnl`, `margin_usage`, `sub_accounts` |
| GET | `/positions` | `getPositions()` — side is the **sign** of `position_info.qty` |
| GET | `/orders/v2` | `getOrders(query)`, `getPendingOrders(instrument?)` |
| GET | `/trades` | `getTrades(query)` |
| GET | `/transfers` | `getTransfers(query)` — the full cash ledger, see below |
| GET | `/settlement_pools/existing` | `getSettlementPool()` |
| GET | `/settlement_pools/leverage` | `getLeverage(assets)` |
| POST | `/settlement_pools/set_leverage` | `setLeverage(asset, leverage)` |
| POST | `/sub_accounts/isolate` · `/deisolate` | `isolate(instrument)` · `deisolate(instrument)` |
| POST | `/sub_accounts/allocation` | `setAllocation(...)` |

List endpoints take `limit`, `offset`, `order_by`, `order` (`asc`/`desc`),
`created_at_gte`, `created_at_lte`, and `instrument` in **key-string** form. Responses come
either as a bare array or `{ result, pagination: { object_count } }`; the client normalises
both to `{ rows, objectCount }`.

### The transfer ledger

`/transfers` is the venue's record of every cash movement on the account. `transfer_type`:

`deposit` · `withdrawal` · `realized_pnl` · `funding` · `fee` · `loss_refund_deposit` ·
`loss_refund_referred_deposit` · `referral_reward` · `collateral_allocation`

Summed over all rows it reconciles to the balance to the cent — deposits − withdrawals −
fees + realised PnL + funding = balance. It is the ground truth for "how much did I make".
`realized_pnl` and `funding` rows carry `reference_instrument`; `fee` rows here are
deposit/withdrawal fees (0.1 USDC each).

## Orders and quotes

Variational is RFQ-based. **A market order needs a quote first.**

| method | path | client |
|---|---|---|
| POST | `/quotes/indicative` | `quoteIndicative({ instrument, qty })` — authenticated |
| POST | `/quotes/simple` | `quoteSimple({ instrument, qty })` — public |
| POST | `/quotes/accept` | `acceptQuote(...)` |
| POST | `/orders/new/market` | `placeMarketOrder({ quoteId, side, maxSlippageBps, isReduceOnly?, brackets? })` |
| POST | `/orders/new/limit` | `placeLimitOrder(...)`, `placeStopLoss(...)`, `placeTakeProfit(...)`, `submitLimitOrder(payload)` |
| POST | `/orders/cancel` | `cancelOrder(rfqId)` |
| POST | `/orders/close_all` | `closeAll(maxSlippageBps)` |
| POST | `/orders/tpsl` | `getTpslOrders(instrument, closingSide)` |
| — | (quote + market, reduce-only) | `closeAtMarket({ instrument, qty, side, maxSlippageBps })` |
| — | (cancel + submit) | `replaceOrder(original, change)` |

`/orders/new/market` body:

```jsonc
{ "quote_id": "…", "side": "buy", "max_slippage": 0.002, "is_reduce_only": false,
  // optional brackets riding along with an entry (not allowed when reduce-only):
  "take_profit": "…", "tp_is_auto_resize": true, "tp_use_mark_price": true, "tp_slippage_limit": "0.01",
  "stop_loss": "…",   "sl_is_auto_resize": true, "sl_use_mark_price": true, "sl_slippage_limit": "0.01" }
```

`max_slippage` is a JSON **number**; the bracket slippage limits are decimal **strings**.

`/orders/new/limit` body — one endpoint for limit, trigger, take-profit and stop-loss:

```jsonc
{ "order_type": "limit" | "take_profit" | "stop_loss",   // lower_snake on the wire
  "instrument": { /* OBJECT form */ },
  "qty": "0.5", "side": "sell",
  "limit_price": "…",      // limit (and so trigger); optional on stop_loss
  "trigger_price": "…",    // take_profit, stop_loss
  "slippage_limit": "0.01", // decimal STRING, fraction of 1
  "is_reduce_only": true, "is_auto_resize": true, "use_mark_price": true }
```

There is no `"trigger"` order type on the wire. The web app's **Trigger** order is sent as
`"order_type": "limit"` with `use_mark_price: true` and the level in `limit_price`
(`placeLimitOrder({ ..., useMarkPrice: true })`). The client always sets
`use_mark_price` explicitly, because the web app defaults it to `false`.

Every mutating response carries **`rfq_id`**. The client refuses to proceed without one;
use it for idempotency and to find the order in `/orders/v2`.

### Order semantics

- The web app's order types are **Market, Limit, Trigger, Take Profit, Stop Loss**. These
  are UI labels, not wire values (the wire values are above). There is **no native
  trailing stop** (the `TrailingStop` string in the bundle belongs to the TradingView
  charting library, not the venue). Trailing must be emulated client-side.
- Triggers are evaluated **every 0.1 s**; a cross shorter than that may not fire. On
  trigger the venue submits a market order, subject to the order's slippage limit — if
  estimated slippage exceeds it, the order stays pending. No fill-price guarantee.
- `use_mark_price` triggers on mark rather than quoted price (mark is the sensible default
  for stops).
- `is_auto_resize` rescales a TP/SL when the position is partly reduced. Without it a
  partial close can cancel the TP/SL entirely.
- A stop loss is always sent reduce-only.
- **There is no atomic replace.** Moving a stop is cancel + submit, which leaves a window
  with no protection. Reconcile after.
- Reduce-only against a flat position is a **benign reject**
  (`rejected_failed_reduce_only_check`, `no_positions`) — don't count it as a failure.
- An order ack is not a fill. A market order can be accepted with an `rfq_id` and still
  fail to clear (e.g. `rejected_clearing_failed_taker_funding` when margin is tight).
  Confirm with `/positions`.

## Funding

`GET /funding/v2?underlying=BTC&instrument_type=perpetual_future` →

```json
{ "predicted_funding_rate": "0.031605", "next_funding_time": "2026-09-24T16:00:00Z", "funding_interval_s": 28800 }
```

- **Unit.** Variational's own API docs call this a decimal ("multiply by 100 for
  percentage") but do not say over what period. `0.031605` is therefore `3.1605%`, and it
  is **unconfirmed** whether that is per funding interval or annualised. The magnitudes
  seen across markets (BTC around ±0.03, small caps around ±0.15) and the venue's
  documented cap of 2% per hour fit an annualised rate better than a per-interval one.
  `TODO(live)`: compare with the funding figure the web app shows for the same market.
- It is a **prediction** of the next payment and drifts live between calls. Not settled.
- It is the **only** funding route. Time-range parameters (`start_time`, `end_time`,
  `limit`, `history`) are ignored — the same single value comes back. There is **no
  market-wide funding history** anywhere in the API or the web app.
- Settled funding exists only **for your own account**, as `funding` rows in `/transfers`.
  The web app's "Funding History" tab is that — an account view, not a market one.
- `funding_interval_s` here is the market's **real** interval (28800 for BTC). Never copy
  it into an instrument object, which always says 3600 (below).

## Wire-format traps

Each of these fails silently or with an unhelpful error.

- **Two instrument encodings.** OBJECT form for POST bodies and WS subscribe frames:
  `{ underlying, instrument_type, settlement_asset: "USDC", funding_interval_s: 3600 }`.
  KEY-STRING form (`P-BTC-USDC-3600`) for `?instrument=` query params and channel names.
  Mixing them returns everything or nothing, never an error. The client brands both types
  so they can't be swapped.
- **`funding_interval_s` is always 3600 in the object form**, even for 8-hour markets.
  Subscribing with the real interval is rejected and kills the socket. RWA instruments
  omit it and carry `kind` instead.
- **Slippage is a fraction of 1** — `0.005` = 0.5% — everywhere, including
  `/orders/close_all`'s `slippage_percent`. Never bps, never percent. The client takes
  bps and converts. `max_slippage` (market orders, quote accept) is a JSON number; the
  limit-order and bracket slippage limits are decimal strings.
- **Numbers are decimal strings** almost everywhere; `/metadata/v2/risk_limits` is the
  exception (JSON numbers). Prices and quantities must respect the quote's
  `min_qty_tick` and the precision rules in `/metadata/config` (at most 6 significant
  figures) — a raw float like `0.30000000000000004` is rejected on decimals. The client
  learns the tick from a quote and truncates.
- **Quotes age out.** `QUOTE_MAX_AGE_MS` forces a re-quote; the client also counts time
  spent waiting for a rate-limit token as quote age.
- **Timestamps are RFC 3339 with nanoseconds** (`…:14.566862123Z`); millisecond
  truncation is lossless for all practical purposes.
- **The asset catalogue grows unannounced.** When `swap` instruments appeared, a strict
  enum rejected the whole `/metadata/supported_assets` response. The client drops rows
  it can't model instead of refusing the catalogue.

## WebSocket

No subprotocol, no query string, no auth in the URL. **The send queue does not survive a
reconnect** — subscriptions and the auth frame must be re-sent on every open (the client
does this).

| path | auth | what |
|---|---|---|
| `/prices` | none | Mark prices for many instruments, ~1 Hz — **display-rounded** |
| `/events` | `{"claims": jwt}` | Cache-invalidation hints for your account |
| `/portfolio` | `{"claims": jwt}` | Portfolio frames, ~4/s |
| `/market_status` | ? | Served, but not mapped yet; the client has no feed for it |

An unknown path still **opens**, then gets one text frame (`unknown path, must be
'/events', '/portfolio', '/prices', or '/market_status'`) and a close. The client's
sockets therefore reset their reconnect backoff only after a JSON frame or a connection
that stays up, never on open alone.

**Liveness.** The server heartbeats every 5 s on `/prices`, `/events` and `/portfolio`.
There are no RFC 6455 ping/pongs — liveness is an inbound-silence watchdog.

For an **unrounded** mark, poll REST `POST /quotes/simple` (`quoteSimple()`): its
`mark_price` is full precision (`63346.7543455801`) where `/prices` gives `63346.75`.

**`/prices`** (`PricesFeed`)

```json
{ "action": "subscribe", "instruments": [ { "underlying": "BTC", "instrument_type": "perpetual_future", "settlement_asset": "USDC", "funding_interval_s": 3600 } ] }
```

- A single unknown instrument kills the whole socket (`unsupported instrument: <key>`).
- Unsubscribing your **last** instrument closes the connection — keep one subscribed.
- Subscribes aren't acked; the first tick lands 0.2–1.1 s later.
- `pricing.timestamp` lags and **repeats** — dedupe on it, not on arrival. Measure
  staleness on arrival time.

**`/quotes/simple` over WebSocket: retired.** The venue used to stream quotes on this
path; since September 2026 it answers "unknown path" and closes. `QuotesFeed` and
`QuotesFeedPool` are still exported, but they now emit `unsupported` and stop instead of
reconnecting. Use REST `quoteSimple()` instead.

**`/events`, `/portfolio`** (`EventsFeed`, `PortfolioFeed`)

- Authenticate with a **first application frame** `{"claims": "<jwt from GET /me>"}`
  within ~2.5 s, or get `Token timeout: Unauthorized` and a close.
- `/events` frames are **hints, never state** — there are no sequence numbers, so a gap is
  undetectable. On any event, re-read REST.
- `/portfolio` frames are a merge over a REST-fetched base, not a snapshot.

## Open questions

Marked `TODO(live)` in the source where they matter:

- Whether an anonymously minted `quote_id` (from `/quotes/simple`) is accepted by
  `/orders/new/market` or `/quotes/accept`.
- The period of `predicted_funding_rate` (per interval or annualised; see Funding).
- What `/market_status` streams.
- Whether `scope: transfer:none` is enforced server-side.
- Exact units of `/sub_accounts/allocation`'s `target_allocation` (almost certainly USDC).
- A few response fields are declared from what the UI reads rather than from a capture;
  the schemas are loose (`z.looseObject`) so extra fields never break parsing.
