/**
 * `OmniClient` — the typed surface over Variational Omni's private API.
 *
 * Every method here is a thin, honest translation of one venue call: exact wire
 * shapes, exact enum spellings, zod on every response. No trailing logic, no
 * persistence, no policy beyond rate limiting and the DRY_RUN gate.
 *
 * Corrections to the original findings doc that are baked in (all verified
 * against the v3.6.4 bundle):
 *   1. `order_type` is lower_snake  — `"stop_loss"`, not `"StopLoss"`.
 *   2. `side` is lowercase          — `"sell"`, not `"Sell"`.
 *   3. `"trigger"` is never SENT    — a trigger order is `limit` + `use_mark_price:true`.
 *   4. `use_mark_price` defaults to FALSE in the reference client, so we always
 *      set it explicitly.
 *   5. `is_reduce_only` is set explicitly on every exit order; the reference
 *      client only gets it right by accident (a trailing object spread
 *      overwrites the branch's own value and a reactive UI statement saves it).
 *   6. Auth is a COOKIE. `x-omni-auth` is a response stamp, not a request header.
 *   7. `/orders/close_all`'s `slippage_percent` is a FRACTION despite the name.
 */

import { z } from 'zod'
import { curlTransport } from './curl-transport.js'
import { InvalidRequestError } from './errors.js'
import {
  CookieJar,
  type DryRunMode,
  type FetchLike,
  type Logger,
  noopLogger,
  OmniHttp,
  type RetryPolicy,
} from './http.js'
import {
  type AssetLike,
  type InstrumentInput,
  type InstrumentKey,
  type InstrumentObject,
  instrumentKey,
  instrumentObject,
  instrumentQuery,
} from './instrument.js'
import { formatPrice, formatQty, validateQty } from './precision.js'
import { RateLimiter, type RateLimiterConfig } from './rate-limit.js'
import * as S from './schemas.js'
import type { Side } from './types.js'
import { bpsToFraction, toWireSide } from './wire.js'

/** Default private API root. Same-origin `/api` in the browser; absolute from a VPS. */
export const DEFAULT_API_BASE = 'https://omni.variational.io/api'

/** The public host. Serves ONLY `/metadata/stats`; every other route 404s. */
export const PUBLIC_STATS_BASE = 'https://omni-client-api.prod.ap-northeast-1.variational.io'

/**
 * Maximum age of a quote we are willing to accept. The venue publishes no TTL
 * but the reference client re-polls at 1 Hz and only ever accepts the
 * newest `quote_id`, so we stay well inside that.
 */
export const QUOTE_MAX_AGE_MS = 900

export type OmniClientOptions = {
  baseUrl?: string
  statsBaseUrl?: string
  /** A cookie jar, or a `document.cookie`-style string copied from a logged-in browser. */
  cookies?: CookieJar | string
  /** Sent as `vr-connected-address`. */
  connectedAddress?: string
  logger?: Logger
  fetchImpl?: FetchLike
  /** Defaults to TRUE: you must opt in, explicitly, to sending anything that touches money. */
  dryRun?: boolean
  /** `synthetic` (default) returns a fake ack; `throw` raises `DryRunViolation`. */
  dryRunMode?: DryRunMode
  rateLimits?: RateLimiterConfig
  retry?: Partial<RetryPolicy>
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Id generator for synthetic dry-run acks. Injectable so tests are deterministic. */
  idFactory?: () => string
  defaultHeaders?: Readonly<Record<string, string>>
}

/* -------------------------------------------------------------------------- */
/* Request payload types (exported so dry-run output can be logged verbatim)   */
/* -------------------------------------------------------------------------- */

/** Bracket orders that ride along with an entry. Only legal when NOT reduce-only. */
export type BracketPayload = {
  take_profit?: string
  tp_is_auto_resize?: boolean
  tp_use_mark_price?: boolean
  tp_slippage_limit?: string
  stop_loss?: string
  sl_is_auto_resize?: boolean
  sl_use_mark_price?: boolean
  sl_slippage_limit?: string
}

export type LimitOrderPayload = BracketPayload & {
  order_type: 'limit' | 'take_profit' | 'stop_loss'
  instrument: InstrumentObject
  qty: string
  side: S.WireSide
  limit_price?: string
  trigger_price?: string
  slippage_limit?: string
  is_reduce_only: boolean
  is_auto_resize: boolean
  use_mark_price: boolean
}

export type MarketOrderPayload = BracketPayload & {
  quote_id: string
  side: S.WireSide
  /** JSON NUMBER, fraction of 1. */
  max_slippage: number
  is_reduce_only: boolean
}

export type AcceptQuotePayload = {
  quote_id: string
  side: S.WireSide
  max_slippage: number
  is_reduce_only: boolean
}

export type OrderListQuery = {
  status?: S.OrderStatus
  /** KEY-STRING form. Passing an object here silently returns the wrong set. */
  instrument?: InstrumentKey | InstrumentKey[]
  limit?: number
  offset?: number
  orderBy?: string
  order?: 'asc' | 'desc'
  createdAtGte?: string
  createdAtLte?: string
}

/** Decoded JWT claims the client actually uses. */
export type TokenClaims = {
  exp?: number | undefined
  address?: string | undefined
  scope?: string | string[] | undefined
}

export class OmniClient {
  readonly http: OmniHttp
  readonly rateLimiter: RateLimiter
  readonly cookies: CookieJar

  private readonly statsBaseUrl: string
  private readonly logger: Logger
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly statsHttp: OmniHttp

  /** The JWT from `/me` or `/auth/login`. Used ONLY for the WS `{claims}` frame. */
  private token: string | undefined
  private address: string | undefined

  /** `min_qty_tick` learned from quotes, per instrument key and side. */
  private readonly tickCache = new Map<string, { bid: string; ask: string }>()

  constructor(options: OmniClientOptions = {}) {
    this.cookies =
      typeof options.cookies === 'string'
        ? CookieJar.parse(options.cookies)
        : (options.cookies ?? new CookieJar())
    this.logger = options.logger ?? noopLogger
    this.now = options.now ?? (() => Date.now())
    this.address = options.connectedAddress
    let counter = 0
    this.idFactory = options.idFactory ?? (() => `${this.now()}-${++counter}`)
    this.rateLimiter = new RateLimiter(options.rateLimits ?? {}, {
      now: this.now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    })
    this.statsBaseUrl = options.statsBaseUrl ?? PUBLIC_STATS_BASE

    const shared = {
      rateLimiter: this.rateLimiter,
      cookies: this.cookies,
      connectedAddress: () => this.address,
      logger: this.logger,
      dryRun: options.dryRun ?? true,
      dryRunMode: options.dryRunMode ?? ('synthetic' as DryRunMode),
      now: this.now,
      // Node's own TLS stack is refused by Cloudflare's challenge on /api regardless
      // of headers, so the curl-backed transport is the DEFAULT, not an option.
      // See curl-transport.ts for the measurements. Tests inject their own.
      fetchImpl: options.fetchImpl ?? curlTransport,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.defaultHeaders === undefined ? {} : { defaultHeaders: options.defaultHeaders }),
    }

    this.http = new OmniHttp({ ...shared, baseUrl: options.baseUrl ?? DEFAULT_API_BASE })
    this.statsHttp = new OmniHttp({ ...shared, baseUrl: this.statsBaseUrl })
  }

  /* ------------------------------------------------------------------ */
  /* Session state                                                       */
  /* ------------------------------------------------------------------ */

  /** DRY_RUN is mutable so a kill switch can be flipped without a rebuild. */
  get dryRun(): boolean {
    return this.http.dryRun
  }

  setDryRun(value: boolean): void {
    this.http.dryRun = value
    this.statsHttp.dryRun = value
    this.logger.warn('omni.dryRun.changed', { dryRun: value })
  }

  /** Replace the whole cookie jar (e.g. after obtaining a fresh session). */
  setSessionCookies(header: string): void {
    for (const name of Object.keys(this.cookies.toJSON())) this.cookies.delete(name)
    this.cookies.importHeader(header)
  }

  setConnectedAddress(address: string | undefined): void {
    this.address = address
  }

  getConnectedAddress(): string | undefined {
    return this.address
  }

  /** The JWT used for the WebSocket `{claims}` frame. */
  getToken(): string | undefined {
    return this.token
  }

  setToken(token: string | undefined): void {
    this.token = token === '' ? undefined : token
  }

  /**
   * Decode the JWT payload. No signature verification — we are the audience of
   * convenience here, not the validator; the venue verifies it. Used for `exp`
   * (proactive session-expiry handling) and `scope` (`transfer:none` sessions
   * cannot deposit or withdraw).
   */
  decodeToken(token: string | undefined = this.token): TokenClaims | undefined {
    if (token === undefined || token === '') return undefined
    const parts = token.split('.')
    const payload = parts[1]
    if (parts.length < 2 || payload === undefined) return undefined
    try {
      const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      )
      const parsed: unknown = JSON.parse(json)
      const claims = z
        .looseObject({
          exp: z.number().optional(),
          address: z.string().optional(),
          scope: z.union([z.string(), z.array(z.string())]).optional(),
        })
        .safeParse(parsed)
      return claims.success ? claims.data : undefined
    } catch {
      return undefined
    }
  }

  /** True when the token expires within `withinSec` (default 30 s, as the bundle does). */
  isTokenExpiring(withinSec = 30): boolean {
    const exp = this.decodeToken()?.exp
    if (exp === undefined) return false
    return exp <= Math.floor(this.now() / 1000) + withinSec
  }

  /* ------------------------------------------------------------------ */
  /* Auth                                                                */
  /* ------------------------------------------------------------------ */

  /** `GET /me` -> `{ token, intercomUserJwt }`. `token: ""` means unauthenticated. */
  async getMe(): Promise<S.Me> {
    const me = await this.http.request({
      method: 'GET',
      path: '/me',
      schema: S.meSchema,
      rateClass: 'auth',
      retryable: true,
    })
    this.setToken(me.token)
    const claims = this.decodeToken()
    if (claims?.address !== undefined && this.address === undefined) this.address = claims.address
    return me
  }

  /** True when `/me` returns a non-empty token. */
  async isAuthenticated(): Promise<boolean> {
    const me = await this.getMe()
    return me.token !== ''
  }

  /**
   * `POST /auth/generate_signing_data` -> the EIP-191 message to `personal_sign`.
   * The body is a bare string; never synthesize it locally, always round-trip.
   */
  async generateSigningData(address: string, transferInitCode?: string): Promise<string> {
    return this.http.request({
      method: 'POST',
      path: '/auth/generate_signing_data',
      body: {
        address,
        ...(transferInitCode === undefined ? {} : { transfer_init_code: transferInitCode }),
      },
      schema: S.signingDataSchema,
      rateClass: 'auth',
    })
  }

  /**
   * `POST /auth/login`. `signedMessage` must have its `0x` prefix STRIPPED —
   * the reference client sends a bare 130-hex-char string.
   *
   * Captcha is a new-account/invite gate: an existing account's login sends
   * neither `captchaToken` nor the `cf-turnstile-*` headers.
   */
  async login(args: {
    address: string
    signedMessage: string
    referralCode?: string
    captchaToken?: string
    interactive?: boolean
  }): Promise<S.LoginResult> {
    const signed = args.signedMessage.startsWith('0x')
      ? args.signedMessage.slice(2)
      : args.signedMessage
    const headers: Record<string, string> =
      args.captchaToken === undefined
        ? {}
        : {
            'cf-turnstile-token': args.captchaToken,
            'cf-turnstile-interactive': String(args.interactive ?? true),
          }
    const result = await this.http.request({
      method: 'POST',
      path: '/auth/login',
      body: {
        address: args.address,
        signed_message: signed,
        ...(args.referralCode === undefined ? {} : { code: args.referralCode.toUpperCase() }),
        ...(args.captchaToken === undefined ? {} : { captchaToken: args.captchaToken }),
      },
      headers,
      schema: S.loginResultSchema,
      rateClass: 'auth',
      mutating: true,
      dryRunResult: () => ({ token: '' }),
    })
    this.setToken(result.token)
    this.address = args.address
    return result
  }

  /**
   * `POST /auth/logout`. Do NOT call this automatically on a 401 — that would destroy
   * a session that may still be recoverable. Exposed for an explicit, deliberate logout.
   */
  async logout(address: string): Promise<{ message: string }> {
    const res = await this.http.request({
      method: 'POST',
      path: '/auth/logout',
      body: { address },
      schema: S.logoutResultSchema,
      rateClass: 'auth',
      mutating: true,
      dryRunResult: () => ({ message: 'SUCCESS' }),
    })
    this.setToken(undefined)
    return res
  }

  /** `POST /auth/switch` — re-point an existing cookie session at another address. */
  async switchAddress(
    address: string,
  ): Promise<{ token?: string | null | undefined; intercomUserJwt?: string | null | undefined }> {
    const res = await this.http.request({
      method: 'POST',
      path: '/auth/switch',
      body: { address },
      schema: S.switchResultSchema,
      rateClass: 'auth',
      mutating: true,
      dryRunResult: () => ({}),
    })
    if (typeof res.token === 'string') this.setToken(res.token)
    this.address = address
    return res
  }

  /* --- Device / QR session transfer -------------------------------------- */

  /** Step 1 (target device): mint a 6-digit init code, valid 60 s. */
  async issueTransferInitCode(): Promise<{ init_id: string; init_code: string }> {
    return this.http.request({
      method: 'POST',
      path: '/auth/issue_transfer_init_code',
      schema: S.transferInitCodeSchema,
      rateClass: 'auth',
      mutating: true,
      dryRunResult: () => ({ init_id: `dry-${this.idFactory()}`, init_code: '000000' }),
    })
  }

  /** Step 1b: poll for consumption (the reference client polls every 2 s). */
  async getTransferInitStatus(initId: string): Promise<z.infer<typeof S.transferInitStatusSchema>> {
    return this.http.request({
      method: 'GET',
      path: '/auth/transfer_init_status',
      query: { init_id: initId },
      schema: S.transferInitStatusSchema,
      rateClass: 'auth',
      retryable: true,
    })
  }

  /** Step 3 (signer device): exchange a signature + init code for a transfer token. */
  async issueTransferToken(args: {
    address: string
    signedMessage: string
    initCode: string
  }): Promise<string> {
    const signed = args.signedMessage.startsWith('0x')
      ? args.signedMessage.slice(2)
      : args.signedMessage
    return this.http.request({
      method: 'POST',
      path: '/auth/issue_transfer_token',
      body: { address: args.address, signed_message: signed, init_code: args.initCode },
      schema: S.transferTokenSchema,
      rateClass: 'auth',
      mutating: true,
      dryRunResult: () => `dry-transfer-${this.idFactory()}`,
    })
  }

  /** Step 4: poll the transfer token (60 s TTL from `created_at`). */
  async getTransferTokenStatus(
    token: string,
  ): Promise<z.infer<typeof S.transferTokenStatusSchema>> {
    return this.http.request({
      method: 'POST',
      path: '/auth/transfer_token_status',
      body: { token },
      schema: S.transferTokenStatusSchema,
      rateClass: 'auth',
      retryable: true,
    })
  }

  /**
   * Step 6 (target device): redeem. Sets the session cookie AND returns the JWT.
   *
   * The resulting session carries `scope: transfer:none` — trade-only, with
   * deposits and withdrawals disabled. For an unattended bot that is a feature.
   * TODO(live): confirm `transfer:none` is enforced server-side, not just in the UI.
   */
  async redeemTransferToken(args: {
    transferToken: string
    initId: string
  }): Promise<{ token: string }> {
    const res = await this.http.request({
      method: 'POST',
      path: '/auth/redeem_transfer_token',
      body: { transfer_token: args.transferToken, init_id: args.initId },
      schema: S.redeemTransferTokenSchema,
      rateClass: 'auth',
      mutating: true,
      dryRunResult: () => ({ token: '' }),
    })
    this.setToken(res.token)
    const claims = this.decodeToken()
    if (claims?.address !== undefined) this.address = claims.address
    return res
  }

  /** `GET /ff` -> feature flags, e.g. `["WL","PS","OR"]`. */
  async getFeatureFlags(): Promise<string[]> {
    return this.http.request({
      method: 'GET',
      path: '/ff',
      schema: S.featureFlagsSchema,
      rateClass: 'meta',
      retryable: true,
    })
  }

  /* ------------------------------------------------------------------ */
  /* Account state                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /positions` -> bare array. One position per instrument, period —
   * margin mode is a property of the position, not a separate identity axis.
   */
  async getPositions(filter?: {
    instrument?: InstrumentKey | InstrumentKey[]
    createdAtGte?: string
    createdAtLte?: string
  }): Promise<S.Position[]> {
    const query: Record<string, string> = {
      ...(filter?.instrument === undefined ? {} : { instrument: joinKeys(filter.instrument) }),
      ...(filter?.createdAtGte === undefined ? {} : { created_at_gte: filter.createdAtGte }),
      ...(filter?.createdAtLte === undefined ? {} : { created_at_lte: filter.createdAtLte }),
    }
    return this.http.request({
      method: 'GET',
      path: '/positions',
      ...(Object.keys(query).length === 0 ? {} : { query }),
      schema: S.positionsSchema,
      rateClass: 'read',
      retryable: true,
    })
  }

  /** `GET /portfolio?compute_margin=true` — the client always passes the flag. */
  async getPortfolio(): Promise<S.Portfolio> {
    return this.http.request({
      method: 'GET',
      path: '/portfolio',
      query: { compute_margin: true },
      schema: S.portfolioSchema,
      rateClass: 'read',
      retryable: true,
    })
  }

  /** `GET /orders/v2`. Handles both the bare-array and `{result,pagination}` forms. */
  async getOrders(query: OrderListQuery = {}): Promise<S.Page<S.Order>> {
    const q: Record<string, string | number> = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...buildListQuery(query),
    }

    const parsed = await this.http.request({
      method: 'GET',
      path: '/orders/v2',
      ...(Object.keys(q).length === 0 ? {} : { query: q }),
      schema: S.ordersPageSchema,
      rateClass: 'read',
      retryable: true,
    })
    return S.toPage(parsed)
  }

  /** Convenience: every pending order, optionally for one instrument. */
  async getPendingOrders(instrument?: InstrumentKey): Promise<S.Order[]> {
    const page = await this.getOrders({
      status: 'pending',
      ...(instrument === undefined ? {} : { instrument }),
    })
    return page.rows
  }

  async getTrades(query: Omit<OrderListQuery, 'status'> = {}): Promise<S.Page<S.Trade>> {
    const q = buildListQuery(query)
    const parsed = await this.http.request({
      method: 'GET',
      path: '/trades',
      ...(Object.keys(q).length === 0 ? {} : { query: q }),
      schema: S.tradesPageSchema,
      rateClass: 'read',
      retryable: true,
    })
    return S.toPage(parsed)
  }

  async getTransfers(query: Omit<OrderListQuery, 'status'> = {}): Promise<S.Page<S.Transfer>> {
    const q = buildListQuery(query)
    const parsed = await this.http.request({
      method: 'GET',
      path: '/transfers',
      ...(Object.keys(q).length === 0 ? {} : { query: q }),
      schema: S.transfersPageSchema,
      rateClass: 'read',
      retryable: true,
    })
    return S.toPage(parsed)
  }

  /* ------------------------------------------------------------------ */
  /* Quotes                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * `POST /quotes/simple` — UNAUTHENTICATED. Full-precision `mark_price` and
   * `index_price`, plus `qty_limits` and a fresh `quote_id`.
   *
   * TODO(live): whether an anonymously-minted `quote_id` is accepted by
   * `/orders/new/market` or `/quotes/accept` is unconfirmed. Use
   * `quoteIndicative` once a session exists.
   */
  async quoteSimple(args: { instrument: InstrumentInput; qty: string | number }): Promise<S.Quote> {
    return this.quote('/quotes/simple', args)
  }

  /** `POST /quotes/indicative` — AUTHENTICATED; adds `margin_requirements`. */
  async quoteIndicative(args: {
    instrument: InstrumentInput
    qty: string | number
  }): Promise<S.Quote> {
    return this.quote('/quotes/indicative', args)
  }

  private async quote(
    path: '/quotes/simple' | '/quotes/indicative',
    args: { instrument: InstrumentInput; qty: string | number },
  ): Promise<S.Quote> {
    const instrument = instrumentObject(args.instrument)
    const quote = await this.http.request({
      method: 'POST',
      path,
      // Minting a quote does not trade, so it is not gated by DRY_RUN and it is
      // safe to retry.
      body: { instrument, qty: String(args.qty) },
      schema: S.quoteSchema,
      rateClass: 'quote',
      retryable: true,
    })
    this.rememberTicks(instrument, quote)
    return quote
  }

  private rememberTicks(instrument: InstrumentObject, quote: S.Quote): void {
    const limits = quote.qty_limits
    if (limits == null) return
    this.tickCache.set(instrumentKey(instrument), {
      bid: limits.bid.min_qty_tick,
      ask: limits.ask.min_qty_tick,
    })
  }

  /**
   * The `min_qty_tick` last seen for an instrument on the given side, if any.
   * `side` is the side of the ORDER: a sell consumes the bid.
   */
  getCachedQtyTick(instrument: InstrumentInput, side: Side): string | undefined {
    const cached = this.tickCache.get(instrumentKey(instrument))
    if (cached === undefined) return undefined
    return side === 'Sell' ? cached.bid : cached.ask
  }

  /**
   * `POST /quotes/accept` — the close/reverse path. `max_slippage` is a JSON
   * NUMBER and a fraction of 1.
   */
  async acceptQuote(args: {
    quoteId: string
    side: Side
    maxSlippageBps: number
    isReduceOnly: boolean
  }): Promise<S.RfqAck> {
    const payload: AcceptQuotePayload = {
      quote_id: args.quoteId,
      side: toWireSide(args.side),
      max_slippage: bpsToFraction(args.maxSlippageBps),
      is_reduce_only: args.isReduceOnly,
    }
    return this.http.request({
      method: 'POST',
      path: '/quotes/accept',
      body: payload,
      schema: S.rfqAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ rfq_id: `dry-run-accept-${this.idFactory()}` }),
    })
  }

  /* ------------------------------------------------------------------ */
  /* Orders                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * LAYER 2, the safety-critical call: a resting exchange-side StopLoss.
   *
   * `is_reduce_only: true` makes it structurally incapable of opening or
   * increasing a position, and because the venue's OI/skew checks use
   * `|new| - |old|`, a reduce-only exit produces a negative delta and can never
   * be rejected for market-cap reasons.
   *
   * `side` is the CLOSING side (opposite of the position's direction).
   */
  async placeStopLoss(args: {
    instrument: InstrumentInput
    qty: string | number
    /** The CLOSING side. */
    side: Side
    triggerPrice: number | string
    maxSlippageBps: number
    /** Rescale the order when the position is partially reduced. Default true. */
    autoResize?: boolean
    /** Trigger on mark rather than quoted price. Default true for a stop-loss. */
    useMarkPrice?: boolean
    /** Optional protective limit; normally omitted so the exit is a market order. */
    limitPrice?: number | string
    /** `min_qty_tick` for rounding. Falls back to the quote cache, then to a quote. */
    minQtyTick?: string
  }): Promise<S.RfqAck> {
    /*
     * Never send a quantity the venue has not told us how to round. The tick cache is
     * filled by REST quotes only; a position opened in the UI and only protected through
     * this client never mints one, so its first stop — and any stop moved after a
     * partial fill, where float arithmetic yields 0.30000000000000004 — would go out as a
     * raw float string. The venue rejects that on decimals, and in a cancel-then-repost
     * the rejection lands AFTER the cancel: the position is left with no stop at all.
     * One indicative quote per instrument fills the cache for the life of the process.
     */
    // Dry run sends nothing, so there is nothing to round for; the quote would be the
    // only network call the rehearsal makes, and dry run should make none.
    if (args.minQtyTick === undefined && !this.dryRun) {
      const instrument = instrumentObject(args.instrument)
      if (this.getCachedQtyTick(instrument, args.side) === undefined) {
        await this.quoteIndicative({ instrument: args.instrument, qty: args.qty })
      }
    }
    return this.submitLimitOrder(this.buildStopLossPayload(args))
  }

  /** Build (but do not send) the StopLoss payload — used by tests and dry-run audits. */
  buildStopLossPayload(args: {
    instrument: InstrumentInput
    qty: string | number
    side: Side
    triggerPrice: number | string
    maxSlippageBps: number
    autoResize?: boolean
    useMarkPrice?: boolean
    limitPrice?: number | string
    minQtyTick?: string
  }): LimitOrderPayload {
    const instrument = instrumentObject(args.instrument)
    const tick = args.minQtyTick ?? this.getCachedQtyTick(instrument, args.side)
    return {
      order_type: 'stop_loss',
      instrument,
      qty: tick === undefined ? String(args.qty) : formatQty(args.qty, tick),
      side: toWireSide(args.side),
      trigger_price: formatPrice(args.triggerPrice),
      ...(args.limitPrice === undefined ? {} : { limit_price: formatPrice(args.limitPrice) }),
      slippage_limit: String(bpsToFraction(args.maxSlippageBps)),
      is_reduce_only: true,
      is_auto_resize: args.autoResize ?? true,
      use_mark_price: args.useMarkPrice ?? true,
    }
  }

  /** A resting TakeProfit. Same shape as the stop-loss, different `order_type`. */
  async placeTakeProfit(args: {
    instrument: InstrumentInput
    qty: string | number
    side: Side
    triggerPrice: number | string
    maxSlippageBps: number
    autoResize?: boolean
    useMarkPrice?: boolean
    minQtyTick?: string
  }): Promise<S.RfqAck> {
    const instrument = instrumentObject(args.instrument)
    const tick = args.minQtyTick ?? this.getCachedQtyTick(instrument, args.side)
    return this.submitLimitOrder({
      order_type: 'take_profit',
      instrument,
      qty: tick === undefined ? String(args.qty) : formatQty(args.qty, tick),
      side: toWireSide(args.side),
      trigger_price: formatPrice(args.triggerPrice),
      slippage_limit: String(bpsToFraction(args.maxSlippageBps)),
      is_reduce_only: true,
      is_auto_resize: args.autoResize ?? true,
      use_mark_price: args.useMarkPrice ?? true,
    })
  }

  /**
   * A plain limit order, or — with `useMarkPrice: true` — what the UI calls a
   * "Trigger" order. The literal string `"trigger"` is NEVER sent.
   */
  async placeLimitOrder(args: {
    instrument: InstrumentInput
    qty: string | number
    side: Side
    limitPrice: number | string
    maxSlippageBps: number
    isReduceOnly?: boolean
    useMarkPrice?: boolean
    autoResize?: boolean
    brackets?: BracketPayload
    minQtyTick?: string
  }): Promise<S.RfqAck> {
    const instrument = instrumentObject(args.instrument)
    const tick = args.minQtyTick ?? this.getCachedQtyTick(instrument, args.side)
    const isReduceOnly = args.isReduceOnly ?? false
    if (isReduceOnly && args.brackets !== undefined) {
      throw new InvalidRequestError('bracket TP/SL cannot be attached to a reduce-only order')
    }
    return this.submitLimitOrder({
      order_type: 'limit',
      instrument,
      qty: tick === undefined ? String(args.qty) : formatQty(args.qty, tick),
      side: toWireSide(args.side),
      limit_price: formatPrice(args.limitPrice),
      slippage_limit: String(bpsToFraction(args.maxSlippageBps)),
      is_reduce_only: isReduceOnly,
      is_auto_resize: args.autoResize ?? false,
      use_mark_price: args.useMarkPrice ?? false,
      ...(args.brackets ?? {}),
    })
  }

  /** Raw `POST /orders/new/limit`. Prefer the typed builders above. */
  async submitLimitOrder(payload: LimitOrderPayload): Promise<S.RfqAck> {
    return this.http.request({
      method: 'POST',
      path: '/orders/new/limit',
      body: payload,
      schema: S.rfqAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ rfq_id: `dry-run-limit-${this.idFactory()}` }),
    })
  }

  /**
   * `POST /orders/new/market`. Takes a `quote_id` — NOT an instrument and NOT a
   * qty; both are baked into the quote.
   */
  async placeMarketOrder(args: {
    quoteId: string
    side: Side
    maxSlippageBps: number
    isReduceOnly?: boolean
    brackets?: BracketPayload
  }): Promise<S.RfqAck> {
    const isReduceOnly = args.isReduceOnly ?? false
    if (isReduceOnly && args.brackets !== undefined) {
      throw new InvalidRequestError('bracket TP/SL cannot be attached to a reduce-only order')
    }
    const payload: MarketOrderPayload = {
      quote_id: args.quoteId,
      side: toWireSide(args.side),
      max_slippage: bpsToFraction(args.maxSlippageBps),
      is_reduce_only: isReduceOnly,
      ...(args.brackets ?? {}),
    }
    return this.http.request({
      method: 'POST',
      path: '/orders/new/market',
      body: payload,
      schema: S.rfqAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ rfq_id: `dry-run-market-${this.idFactory()}` }),
    })
  }

  /**
   * Close (part of) a position at market: quote, then accept.
   *
   * The quote is re-minted if the round trip would push it past
   * {@link QUOTE_MAX_AGE_MS}. `side` is the CLOSING side, which also selects
   * the price you get: a sell fills at `bid`, a buy at `ask`.
   */
  async closeAtMarket(args: {
    instrument: InstrumentInput
    qty: string | number
    side: Side
    maxSlippageBps: number
    /** Use the authenticated quote endpoint. Default true (a session is assumed). */
    indicative?: boolean
    /** Route through `/orders/new/market` instead of `/quotes/accept`. */
    viaOrdersEndpoint?: boolean
  }): Promise<{ ack: S.RfqAck; quote: S.Quote; requoted: boolean }> {
    const useIndicative = args.indicative ?? true
    let requoted = false
    let qty: string | number = args.qty
    const mint = (q: string | number): Promise<S.Quote> =>
      useIndicative
        ? this.quoteIndicative({ instrument: args.instrument, qty: q })
        : this.quoteSimple({ instrument: args.instrument, qty: q })

    /*
     * `mintedAt` is taken BEFORE the request. A quote's age is measured from when the
     * venue priced it, and the round trip is part of that age; stamping after the
     * response made the freshness check below measure only the synchronous validation
     * between two lines of this function -- it could never fire.
     */
    let mintedAt = this.now()
    let quote = await mint(qty)

    if (quote.qty_limits != null) {
      const limit = args.side === 'Sell' ? quote.qty_limits.bid : quote.qty_limits.ask
      const check = validateQty(qty, limit)
      if (!check.ok) {
        /*
         * A decimals violation is ours to fix, not a reason to refuse: float arithmetic
         * after a partial fill yields 0.19999999999999998 for a position the
         * venue itself sized. Truncate to the tick the quote just told us, and re-quote
         * because the quote has the quantity baked in. Anything else (min, max, zero)
         * is a genuine refusal.
         */
        const truncated = formatQty(qty, limit.min_qty_tick)
        const retry = truncated !== String(qty) ? validateQty(truncated, limit) : check
        if (!retry.ok) throw new InvalidRequestError(`close rejected before send: ${check.reason}`)
        qty = truncated
        mintedAt = this.now()
        quote = await mint(qty)
        requoted = true
      }
    }

    /*
     * The accept still has to win an `order` token; a burst of stop moves can leave
     * that bucket dry for longer than the whole freshness budget. Count the wait as
     * age now rather than discovering it as `quote_expired` after the fact.
     */
    const projectedAge = this.now() - mintedAt + this.rateLimiter.waitMs('order')
    if (projectedAge > QUOTE_MAX_AGE_MS) {
      mintedAt = this.now()
      quote = await mint(qty)
      requoted = true
    }

    const ack =
      args.viaOrdersEndpoint === true
        ? await this.placeMarketOrder({
            quoteId: quote.quote_id,
            side: args.side,
            maxSlippageBps: args.maxSlippageBps,
            isReduceOnly: true,
          })
        : await this.acceptQuote({
            quoteId: quote.quote_id,
            side: args.side,
            maxSlippageBps: args.maxSlippageBps,
            isReduceOnly: true,
          })

    return { ack, quote, requoted }
  }

  /** `POST /orders/cancel { rfq_id }`. The venue's body is discarded; 2xx == success. */
  async cancelOrder(rfqId: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/orders/cancel',
      body: { rfq_id: rfqId },
      schema: S.opaqueAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ canceled: rfqId }),
    })
  }

  /**
   * There is NO atomic replace endpoint: "move the stop" is cancel + submit.
   *
   * That leaves a window with no exchange-side protection. Treat it as a two-phase
   * operation and reconcile afterwards; when the submit fails, the caller still holds
   * `original` and can re-place it.
   */
  async replaceOrder(
    original: S.Order,
    change: Partial<Pick<LimitOrderPayload, 'limit_price' | 'trigger_price' | 'qty'>>,
  ): Promise<S.RfqAck> {
    const orderType = original.order_type
    if (orderType !== 'limit' && orderType !== 'take_profit' && orderType !== 'stop_loss') {
      throw new InvalidRequestError(`cannot replace an order of type "${orderType}"`)
    }
    /*
     * A replace is a cancel followed by a fresh submit built from this order's own
     * fields, so an unknown size makes it impossible. `qty` is nullable on /orders/v2
     * (observed live). Refuse BEFORE the cancel: coercing null to 0 would cancel a real
     * resting order and replace it with a nonsense one, leaving the position bare.
     */
    const originalQty = original.qty
    if (originalQty === null || originalQty === undefined || originalQty === '') {
      throw new InvalidRequestError(
        `cannot replace order ${original.rfq_id}: the venue reported no qty for it`,
      )
    }
    const payload: LimitOrderPayload = {
      order_type: orderType,
      instrument: instrumentObject(original.instrument),
      qty: originalQty,
      side: original.side,
      ...(original.limit_price == null ? {} : { limit_price: original.limit_price }),
      ...(original.trigger_price == null ? {} : { trigger_price: original.trigger_price }),
      ...(original.slippage_limit == null ? {} : { slippage_limit: original.slippage_limit }),
      is_reduce_only: original.is_reduce_only ?? true,
      is_auto_resize: original.is_auto_resize ?? true,
      use_mark_price: original.use_mark_price ?? true,
      ...change,
    }
    await this.cancelOrder(original.rfq_id)
    return this.submitLimitOrder(payload)
  }

  /**
   * `POST /orders/tpsl { instrument, side }` -> the pending TP/SL for that
   * position. `side` is the CLOSING side. Returns a BARE ARRAY.
   */
  async getTpslOrders(instrument: InstrumentInput, closingSide: Side): Promise<S.Order[]> {
    return this.http.request({
      method: 'POST',
      path: '/orders/tpsl',
      body: { instrument: instrumentObject(instrument), side: toWireSide(closingSide) },
      schema: z.array(S.orderSchema),
      rateClass: 'read',
      retryable: true,
    })
  }

  /**
   * `POST /orders/close_all`. NOTE `slippage_percent` is a FRACTION despite the
   * name — we take bps and convert, so the ambiguity dies here.
   */
  async closeAll(maxSlippageBps: number): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/orders/close_all',
      body: { slippage_percent: String(bpsToFraction(maxSlippageBps)) },
      schema: S.opaqueAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ closed: 'all' }),
    })
  }

  /* ------------------------------------------------------------------ */
  /* Metadata                                                            */
  /* ------------------------------------------------------------------ */

  async getConfig(): Promise<S.MetadataConfig> {
    return this.http.request({
      method: 'GET',
      path: '/metadata/config',
      schema: S.metadataConfigSchema,
      rateClass: 'meta',
      retryable: true,
    })
  }

  /** `GET /metadata/supported_assets` -> `{ [symbol]: [assetRow] }`, 538 symbols today. */
  async getSupportedAssets(): Promise<Record<string, S.SupportedAsset[]>> {
    return this.http.request({
      method: 'GET',
      path: '/metadata/supported_assets',
      schema: S.supportedAssetsSchema,
      rateClass: 'meta',
      retryable: true,
    })
  }

  /** Flattened `{symbol -> assetRow}`, dropping the single-element array wrapper. */
  async getAssetIndex(): Promise<Map<string, S.SupportedAsset>> {
    const raw = await this.getSupportedAssets()
    const out = new Map<string, S.SupportedAsset>()
    for (const [symbol, rows] of Object.entries(raw)) {
      const row = rows[0]
      if (row !== undefined) out.set(symbol, row)
    }
    return out
  }

  /**
   * `GET /metadata/v2/risk_limits` — note these come back as JSON NUMBERS, not
   * decimal strings, unlike almost everything else.
   */
  async getRiskLimits(instrument: InstrumentInput): Promise<S.RiskLimits> {
    return this.http.request({
      method: 'GET',
      path: '/metadata/v2/risk_limits',
      query: instrumentQuery(instrument),
      schema: S.riskLimitsSchema,
      rateClass: 'meta',
      retryable: true,
    })
  }

  async getOpenInterest(
    instrument: InstrumentInput,
  ): Promise<z.infer<typeof S.openInterestSchema>> {
    return this.http.request({
      method: 'GET',
      path: '/metadata/v2/open_interest',
      query: instrumentQuery(instrument),
      schema: S.openInterestSchema,
      rateClass: 'meta',
      retryable: true,
    })
  }

  /**
   * `GET /funding/v2`. `funding_interval_s` here is the market's REAL interval
   * (28800 for BTC) — never copy it into an instrument object, which is always 3600.
   */
  async getFunding(instrument: InstrumentInput): Promise<S.Funding> {
    return this.http.request({
      method: 'GET',
      path: '/funding/v2',
      query: instrumentQuery(instrument),
      schema: S.fundingSchema,
      rateClass: 'meta',
      retryable: true,
    })
  }

  async getTiers(): Promise<z.infer<typeof S.tierSchema>[]> {
    return this.http.request({
      method: 'GET',
      path: '/metadata/tiers',
      schema: z.array(S.tierSchema),
      rateClass: 'meta',
      retryable: true,
    })
  }

  /**
   * `GET /metadata/stats`. Served by BOTH the private API and the public host;
   * `viaPublicHost` picks the latter, which needs no session.
   */
  async getStats(viaPublicHost = false): Promise<z.infer<typeof S.statsSchema>> {
    const http = viaPublicHost ? this.statsHttp : this.http
    return http.request({
      method: 'GET',
      path: '/metadata/stats',
      schema: S.statsSchema,
      rateClass: 'meta',
      retryable: true,
    })
  }

  /* ------------------------------------------------------------------ */
  /* Settlement pools & sub-accounts (margin mode)                       */
  /* ------------------------------------------------------------------ */

  async getSettlementPool(): Promise<S.SettlementPool> {
    return this.http.request({
      method: 'GET',
      path: '/settlement_pools/existing',
      schema: S.settlementPoolSchema,
      rateClass: 'read',
      retryable: true,
    })
  }

  /** `POST /settlement_pools/leverage { assets }` — per ASSET, not per instrument. */
  async getLeverage(assets: string[]): Promise<z.infer<typeof S.leverageSchema>> {
    return this.http.request({
      method: 'POST',
      path: '/settlement_pools/leverage',
      body: { assets },
      schema: S.leverageSchema,
      rateClass: 'read',
      retryable: true,
    })
  }

  async setLeverage(asset: string, leverage: number | string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/settlement_pools/set_leverage',
      body: { asset, leverage: String(leverage) },
      schema: S.opaqueAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ asset, leverage: String(leverage) }),
    })
  }

  /** Cross -> isolated. Asynchronous: poll `getConversion` until it settles. */
  async isolate(instrument: InstrumentInput): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/sub_accounts/isolate',
      body: { instrument: instrumentObject(instrument) },
      schema: S.opaqueAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ isolated: true }),
    })
  }

  /** Isolated -> cross. */
  async deisolate(instrument: InstrumentInput): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/sub_accounts/deisolate',
      body: { instrument: instrumentObject(instrument) },
      schema: S.opaqueAckSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ isolated: false }),
    })
  }

  /**
   * Resize an isolated sub-account's margin.
   * TODO(live): `target_allocation` units are near-certainly USDC, but the
   * bundle's builder was not traced — confirm before using it with real money.
   */
  async setAllocation(
    instrument: InstrumentInput,
    targetAllocation: string | number,
  ): Promise<S.Conversion> {
    return this.http.request({
      method: 'POST',
      path: '/sub_accounts/allocation',
      body: {
        instrument: instrumentObject(instrument),
        target_allocation: String(targetAllocation),
      },
      schema: S.conversionSchema,
      rateClass: 'order',
      mutating: true,
      dryRunResult: () => ({ conversion_id: `dry-${this.idFactory()}`, status: 'pending' }),
    })
  }

  async getConversion(conversionId: string): Promise<S.Conversion> {
    return this.http.request({
      method: 'GET',
      path: `/sub_accounts/conversions/${encodeURIComponent(conversionId)}`,
      schema: S.conversionSchema,
      rateClass: 'read',
      retryable: true,
    })
  }

  /**
   * Margin mode for an instrument, derived the only way the venue allows: by
   * looking the instrument up in `portfolio.sub_accounts.isolated`. A position
   * row carries no `margin_mode` field at all.
   */
  static marginModeOf(portfolio: S.Portfolio, instrument: InstrumentInput): 'cross' | 'isolated' {
    return OmniClient.isolatedSubAccountFor(portfolio, instrument) === undefined
      ? 'cross'
      : 'isolated'
  }

  static isolatedSubAccountFor(
    portfolio: S.Portfolio,
    instrument: InstrumentInput,
  ): S.IsolatedSubAccount | undefined {
    const wanted = instrumentKey(instrument)
    const isolated = portfolio.sub_accounts?.isolated
    if (isolated == null) return undefined
    return isolated.find((sa) => instrumentKey(sa.instrument) === wanted)
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function joinKeys(keys: InstrumentKey | InstrumentKey[]): string {
  return Array.isArray(keys) ? keys.join(',') : keys
}

function buildListQuery(query: Omit<OrderListQuery, 'status'>): Record<string, string | number> {
  return {
    ...(query.instrument === undefined ? {} : { instrument: joinKeys(query.instrument) }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.offset === undefined ? {} : { offset: query.offset }),
    ...(query.orderBy === undefined ? {} : { order_by: query.orderBy }),
    ...(query.order === undefined ? {} : { order: query.order }),
    ...(query.createdAtGte === undefined ? {} : { created_at_gte: query.createdAtGte }),
    ...(query.createdAtLte === undefined ? {} : { created_at_lte: query.createdAtLte }),
  }
}

/** Re-exported so callers can type an asset row without reaching into schemas. */
export type { AssetLike }
