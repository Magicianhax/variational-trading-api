/**
 * Zod schemas for every Omni wire shape we read or write.
 *
 * Conventions:
 *  - Objects are `z.looseObject` (zod v4's passthrough): additive server-side
 *    changes must not break us, but every field we actually read is declared
 *    and typed. A missing/retyped declared field is schema drift and raises
 *    `SchemaDriftError` at the transport, so a caller stops instead of guessing.
 *  - Monetary/quantity values arrive as DECIMAL STRINGS almost everywhere. The
 *    exceptions (`/metadata/v2/risk_limits`) are JSON numbers. Do not assume
 *    uniform typing; the schemas below record which is which.
 *  - `TODO(live)` marks a field whose shape is inferred from the minified
 *    bundle rather than observed on the wire. Each one names what must be
 *    confirmed against a live capture.
 */

import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** A decimal number rendered as a string, e.g. `"63555.71"`. */
export const decimalString = z.string()

/** Fields recon saw only as strings but which a server tweak could make numeric. */
const numericLoose = z.union([z.string(), z.number()])

/** RFC3339 timestamp string as Omni emits it (nanosecond precision is common). */
export const timestampString = z.string()

/* -------------------------------------------------------------------------- */
/* Enums — exact wire spellings (lower_snake, NOT the TS enum keys)           */
/* -------------------------------------------------------------------------- */

export const instrumentTypeSchema = z.enum([
  'vanilla_option',
  'dated_future',
  'perpetual_future',
  'perpetual_rwa_future',
  'perpetual_cfd',
])
export type InstrumentType = z.infer<typeof instrumentTypeSchema>

export const assetClassSchema = z.enum(['etf', 'equity', 'index', 'commodity'])
export type AssetClass = z.infer<typeof assetClassSchema>

/** `"buy"` / `"sell"` — lowercase. The domain type `Side` is `'Buy' | 'Sell'`. */
export const wireSideSchema = z.enum(['buy', 'sell'])
export type WireSide = z.infer<typeof wireSideSchema>

/** `"trigger"` is never SENT (a UI trigger is `limit` + `use_mark_price:true`) but is read back. */
export const orderTypeSchema = z.enum([
  'market',
  'limit',
  'trigger',
  'take_profit',
  'stop_loss',
  'stop_limit',
])
export type OrderType = z.infer<typeof orderTypeSchema>

export const orderStatusSchema = z.enum(['pending', 'cleared', 'rejected', 'canceled'])
export type OrderStatus = z.infer<typeof orderStatusSchema>

export const tradeStatusSchema = z.enum([
  'pending',
  'failed',
  'confirmed',
  'cleared',
  'rejected',
  'canceled',
])

export const tradeTypeSchema = z.enum([
  'trade',
  'settlement',
  'liquidation',
  'settlement_market_delisted',
])

export const roleSchema = z.enum(['maker', 'taker'])

export const tifSchema = z.enum(['fill_or_kill', 'good_til_canceled'])

export const clearingStatusSchema = z.enum([
  'pending_taker_deposit_approval',
  'pending_maker_deposit_approval',
  'pending_maker_last_look',
  'pending_clearing',
  'pending_pool_creation',
  'pending_atomic_deposit',
  'rejected_clearing_failed_taker_deposit_approval',
  'rejected_clearing_failed_maker_deposit_approval',
  'rejected_clearing_failed_maker_deposit',
  'rejected_clearing_failed_taker_deposit',
  'rejected_maker_last_look_rejected',
  'rejected_maker_last_look_expired',
  'rejected_clearing_failed_pool_creation',
  'rejected_clearing_failed_taker_funding',
  'rejected_clearing_failed_maker_funding',
  'rejected_failed_atomic_deposit',
  'success_trades_booked_into_pool',
])
export type ClearingStatus = z.infer<typeof clearingStatusSchema>

/**
 * Reject reasons appear in the i18n table that are absent from the TS enum, so
 * the union stays open. Callers branch on `startsWith('rejected_')`.
 */
export const clearingStatusLoose = z.union([clearingStatusSchema, z.string()])

export const cancelReasonSchema = z.union([
  z.enum([
    'user_cancel',
    'no_positions',
    'no_positions_for_side',
    'parent_order_canceled',
    'parent_order_rejected',
    'market_delisted',
    'order_size_exceeds_position',
    'admin_cancel',
  ]),
  z.string(),
])

export const transferTypeSchema = z.union([
  z.enum([
    'deposit',
    'withdrawal',
    'realized_pnl',
    'funding',
    'fee',
    'loss_refund_deposit',
    'loss_refund_referred_deposit',
    'referral_reward',
    'collateral_allocation',
  ]),
  z.string(),
])

/**
 * `error_code` values from the risk-check enum. NOTE the bundle's enum is
 * visibly corrupted at the tail (`maxConcurrentOrders = "global_configs_check"`,
 * `globalConfigsCheck = "internal"`), so only the VALUES are authoritative.
 * TODO(live): confirm whether `"max_concurrent_orders"` is also emitted.
 */
export const errorCodeSchema = z.union([
  z.enum([
    'user_gross_notional_limit_risk_check',
    'user_net_notional_limit_risk_check',
    'user_instrument_limit_risk_check',
    'user_risk_checks',
    'olp_risk_checks',
    'olp_var_limit_risk_check',
    'olp_gross_notional_risk_check',
    'olp_net_notional_risk_check',
    'olp_position_limit_risk_check',
    'skew_as_percent_of_fdv_limit',
    'oi_as_percent_of_fdv_limit',
    'skew_limit_exceeded',
    'oi_limit_exceeded',
    'global_configs_check',
    'internal',
  ]),
  z.string(),
])

/* -------------------------------------------------------------------------- */
/* Instrument                                                                 */
/* -------------------------------------------------------------------------- */

export const dexTokenDetailsSchema = z.looseObject({
  network: z.string(),
  underlying_address: z.string(),
})
export type DexTokenDetails = z.infer<typeof dexTokenDetailsSchema>

/**
 * The instrument OBJECT form — what goes in POST bodies and comes back inside
 * `position_info.instrument`. Distinct from the KEY-STRING form
 * (`P-BTC-USDC-3600`) used by `?instrument=` and by WS channel names.
 */
export const instrumentSchema = z.looseObject({
  underlying: z.string(),
  instrument_type: instrumentTypeSchema,
  settlement_asset: z.string().optional(),
  funding_interval_s: z.number().optional(),
  /** Present on `perpetual_rwa_future` / `perpetual_cfd` only. */
  kind: assetClassSchema.optional(),
  dex_token_details: dexTokenDetailsSchema.nullish(),
  /** Dated futures / options only; never for perps. */
  expiry: z.string().nullish(),
  strike: numericLoose.nullish(),
})
export type InstrumentWire = z.infer<typeof instrumentSchema>

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

/** `GET /me` — `token` is `""` when unauthenticated. */
export const meSchema = z.looseObject({
  token: z.string(),
  intercomUserJwt: z.string().nullish(),
})
export type Me = z.infer<typeof meSchema>

/** `POST /auth/login` — plus a `Set-Cookie` carrying the real session. */
export const loginResultSchema = z.looseObject({
  token: z.string(),
  intercomUserJwt: z.string().nullish(),
})
export type LoginResult = z.infer<typeof loginResultSchema>

/** `POST /auth/switch` returns the same shape, but both fields may be absent. */
export const switchResultSchema = z.looseObject({
  token: z.string().nullish(),
  intercomUserJwt: z.string().nullish(),
})

/** `POST /auth/logout` -> `{ message: "SUCCESS" }`. */
export const logoutResultSchema = z.looseObject({ message: z.string() })

/**
 * `POST /auth/generate_signing_data` returns the message to sign as a BARE
 * STRING (JSON string literal or text/plain) — there is no `.message` wrapper.
 */
export const signingDataSchema = z.string()

export const transferInitCodeSchema = z.looseObject({
  init_id: z.string(),
  init_code: z.string(),
})

/** TODO(live): only `consumed_at` is read by the reference client; the rest is inferred. */
export const transferInitStatusSchema = z.looseObject({
  consumed_at: z.string().nullish(),
  created_at: z.string().nullish(),
})

/** `POST /auth/issue_transfer_token` -> a bare token string. */
export const transferTokenSchema = z.string()

export const transferTokenStatusSchema = z.looseObject({
  created_at: z.string(),
  consumed_at: z.string().nullish(),
})

export const redeemTransferTokenSchema = z.looseObject({ token: z.string() })

/** `GET /ff` -> `["WL","PS","OR"]`. */
export const featureFlagsSchema = z.array(z.string())

/* -------------------------------------------------------------------------- */
/* Positions & portfolio                                                      */
/* -------------------------------------------------------------------------- */

export const positionInfoSchema = z.looseObject({
  instrument: instrumentSchema,
  /** SIGNED decimal string. `> 0` = long, `< 0` = short. */
  qty: decimalString,
  avg_entry_price: decimalString,
  updated_at: timestampString.nullish(),
})

/** TODO(live): `price_info` may carry more than `.price`; nothing else is read by the bundle. */
export const priceInfoSchema = z.looseObject({ price: decimalString })

export const pendingOrderCountsSchema = z.looseObject({
  stop_loss: numericLoose.nullish(),
  take_profit: numericLoose.nullish(),
})

export const positionSchema = z.looseObject({
  position_info: positionInfoSchema,
  price_info: priceInfoSchema,
  upnl: decimalString,
  rpnl: decimalString,
  /** SIGNED notional. The UI takes `Math.abs` for display. */
  value: decimalString,
  cum_funding: decimalString.nullish(),
  estimated_liquidation_price: decimalString.nullish(),
  initial_margin: decimalString.nullish(),
  maintenance_margin: decimalString.nullish(),
  pending_order_counts: pendingOrderCountsSchema.nullish(),
})
export type Position = z.infer<typeof positionSchema>

export const positionsSchema = z.array(positionSchema)

export const marginPairSchema = z.looseObject({
  initial_margin: decimalString,
  maintenance_margin: decimalString,
})

export const isolatedSubAccountSchema = z.looseObject({
  instrument: instrumentSchema,
  balance: decimalString,
  allocated_qty: decimalString.nullish(),
  initial_margin: decimalString.nullish(),
  maintenance_margin: decimalString.nullish(),
  available: decimalString.nullish(),
})
export type IsolatedSubAccount = z.infer<typeof isolatedSubAccountSchema>

/** TODO(live): full `sub_accounts` field list needs an authenticated capture. */
export const subAccountsSchema = z.looseObject({
  cross: z
    .looseObject({
      balance: decimalString.nullish(),
      initial_margin: decimalString.nullish(),
      maintenance_margin: decimalString.nullish(),
    })
    .nullish(),
  cross_available: decimalString.nullish(),
  cross_free_to_mm: decimalString.nullish(),
  isolated: z.array(isolatedSubAccountSchema).nullish(),
})

/**
 * `GET /portfolio?compute_margin=true`. Also arrives push-style over the
 * `/portfolio` socket as `pool_portfolio_result`.
 * TODO(live): confirm the exact field list; only fields the UI reads are declared.
 */
export const portfolioSchema = z.looseObject({
  balance: decimalString.nullish(),
  upnl: decimalString.nullish(),
  margin_usage: marginPairSchema.nullish(),
  sub_accounts: subAccountsSchema.nullish(),
})
export type Portfolio = z.infer<typeof portfolioSchema>

/* -------------------------------------------------------------------------- */
/* Orders, trades, transfers                                                  */
/* -------------------------------------------------------------------------- */

export const failedRiskCheckSchema = z.looseObject({
  id: numericLoose.nullish(),
  name: z.string().nullish(),
  passed: z.boolean().nullish(),
  limit: numericLoose.nullish(),
  result: numericLoose.nullish(),
  message: z.string().nullish(),
  risk_limit: numericLoose.nullish(),
})

export const orderSchema = z.looseObject({
  rfq_id: z.string(),
  instrument: instrumentSchema,
  side: wireSideSchema,
  /*
   * Nullable in the wild — observed live on /orders/v2. Refusing the whole listing,
   * and with it sight of every stop protecting an open position, because one row carries
   * a null is a far worse failure than accepting it; check `qty > 0` where you use it.
   */
  qty: decimalString.nullish(),
  order_type: orderTypeSchema,
  limit_price: decimalString.nullish(),
  trigger_price: decimalString.nullish(),
  /** Only meaningful when `status === "cleared"`. */
  price: decimalString.nullish(),
  status: orderStatusSchema,
  clearing_status: clearingStatusLoose.nullish(),
  cancel_reason: cancelReasonSchema.nullish(),
  failed_risk_checks: z.array(failedRiskCheckSchema).nullish(),
  is_reduce_only: z.boolean().nullish(),
  is_auto_resize: z.boolean().nullish(),
  use_mark_price: z.boolean().nullish(),
  slippage_limit: decimalString.nullish(),
  tif: tifSchema.nullish(),
  created_at: timestampString.nullish(),
})
export type Order = z.infer<typeof orderSchema>

export const tradeSchema = z.looseObject({
  id: z.string(),
  instrument: instrumentSchema,
  side: wireSideSchema,
  price: decimalString,
  qty: decimalString,
  trade_type: tradeTypeSchema,
  role: roleSchema.nullish(),
  status: tradeStatusSchema.nullish(),
  liquidation_trigger_price: decimalString.nullish(),
  source_rfq: z.string().nullish(),
  created_at: timestampString.nullish(),
})
export type Trade = z.infer<typeof tradeSchema>

export const transferSchema = z.looseObject({
  id: z.string(),
  asset: z.string(),
  qty: decimalString,
  transfer_type: transferTypeSchema,
  funding_type: z.string().nullish(),
  status: tradeStatusSchema.nullish(),
  reference_instrument: instrumentSchema.nullish(),
  failure_reason: z.string().nullish(),
  confirmed_by_transaction_id: z.string().nullish(),
  created_at: timestampString.nullish(),
})
export type Transfer = z.infer<typeof transferSchema>

/**
 * Paginated collections come back EITHER as a bare array OR as
 * `{ result, pagination }`. Both forms must be handled — the bundle's `ps`
 * helper does exactly this.
 */
export function paginated<T extends z.ZodType>(item: T) {
  return z.union([
    z.array(item),
    z.looseObject({
      result: z.array(item),
      pagination: z.looseObject({ object_count: z.number().nullish() }).nullish(),
    }),
  ])
}

export type Page<T> = { rows: T[]; objectCount: number | undefined }

/** Normalise either paginated form into `{ rows, objectCount }`. */
export function toPage<T>(
  parsed:
    | T[]
    | { result: T[]; pagination?: { object_count?: number | null | undefined } | null | undefined },
): Page<T> {
  if (Array.isArray(parsed)) return { rows: parsed, objectCount: undefined }
  const count = parsed.pagination?.object_count
  return { rows: parsed.result, objectCount: count == null ? undefined : count }
}

/** Concrete page schemas for the three paginated collections we read. */
export const ordersPageSchema = paginated(orderSchema)
export const tradesPageSchema = paginated(tradeSchema)
export const transfersPageSchema = paginated(transferSchema)

/** Every order-submitting endpoint answers with an RFQ id; the client throws if it is missing. */
export const rfqAckSchema = z.looseObject({ rfq_id: z.string() })
export type RfqAck = z.infer<typeof rfqAckSchema>

/**
 * `/orders/cancel` and `/orders/close_all` bodies are DISCARDED by the
 * reference client (2xx == success), so their shape is genuinely unknown.
 * TODO(live): capture one of each and tighten this.
 */
export const opaqueAckSchema = z.unknown()

/* -------------------------------------------------------------------------- */
/* Quotes                                                                     */
/* -------------------------------------------------------------------------- */

export const qtyLimitSideSchema = z.looseObject({
  min_qty: decimalString,
  max_qty: decimalString,
  min_qty_tick: decimalString,
})

export const qtyLimitsSchema = z.looseObject({
  bid: qtyLimitSideSchema,
  ask: qtyLimitSideSchema,
})

export const marginRequirementsSchema = z.looseObject({
  existing_margin: marginPairSchema.nullish(),
  bid_margin_delta: marginPairSchema.nullish(),
  ask_margin_delta: marginPairSchema.nullish(),
  bid_max_notional_delta: decimalString.nullish(),
  ask_max_notional_delta: decimalString.nullish(),
  estimated_liquidation_price_bid: decimalString.nullish(),
  estimated_liquidation_price_ask: decimalString.nullish(),
})

/**
 * `/quotes/simple` (unauthenticated) and `/quotes/indicative` (authenticated)
 * share this shape; only the latter carries `margin_requirements`.
 *
 * `bid` is the price you SELL at, `ask` the price you BUY at.
 */
export const quoteSchema = z.looseObject({
  quote_id: z.string(),
  qty: decimalString,
  bid: decimalString,
  ask: decimalString,
  instrument: instrumentSchema.nullish(),
  mark_price: decimalString.nullish(),
  index_price: decimalString.nullish(),
  timestamp: timestampString.nullish(),
  qty_limits: qtyLimitsSchema.nullish(),
  margin_requirements: marginRequirementsSchema.nullish(),
})
export type Quote = z.infer<typeof quoteSchema>

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

export const precisionRequirementsSchema = z.looseObject({
  min_decimal_figures: z.number(),
  max_decimal_only_figures: z.number(),
  max_significant_figures: z.number(),
})

export const metadataConfigSchema = z.looseObject({
  min_order_notional: decimalString,
  max_order_notional: decimalString,
  /** DISPLAY spec only — never used to round wire values. */
  default_precision_requirements: precisionRequirementsSchema.nullish(),
  transfer_fee: decimalString.nullish(),
  futures_taker_fee: decimalString.nullish(),
  pool_creation_fee: decimalString.nullish(),
  referrals_activation_volume: decimalString.nullish(),
  referrals_extra_capacity_volume: decimalString.nullish(),
  default_margin_params: z.unknown().optional(),
})
export type MetadataConfig = z.infer<typeof metadataConfigSchema>

export const openInterestPairSchema = z.looseObject({
  long_open_interest: decimalString,
  short_open_interest: decimalString,
})

/**
 * One row of `/metadata/supported_assets`. NOTE the symbol lives in `asset`
 * here, while the bundle's instrument builder reads `.symbol` off its own
 * mapped store — `instrumentObject` bridges that.
 */
export const supportedAssetSchema = z.looseObject({
  asset: z.string(),
  name: z.string().nullish(),
  is_dex: z.boolean().nullish(),
  token_uri: z.string().nullish(),
  listed_at: timestampString.nullish(),
  price: decimalString.nullish(),
  index_price: decimalString.nullish(),
  fdv: decimalString.nullish(),
  price_change_percentage_24h: decimalString.nullish(),
  volume_24h: decimalString.nullish(),
  funding_rate: decimalString.nullish(),
  next_funding_rate: decimalString.nullish(),
  funding_time: timestampString.nullish(),
  /** The market's REAL funding interval. Never put this in an instrument object. */
  funding_interval_s: z.number().nullish(),
  open_interest: openInterestPairSchema.nullish(),
  coingecko_id: z.string().nullish(),
  is_close_only_mode: z.boolean().nullish(),
  is_isolable: z.boolean().nullish(),
  has_perp: z.boolean().nullish(),
  instrument_type: instrumentTypeSchema.nullish(),
  asset_class: assetClassSchema.nullish(),
  dex_token_details: dexTokenDetailsSchema.nullish(),
})
export type SupportedAsset = z.infer<typeof supportedAssetSchema>

/** `GET /metadata/supported_assets` -> `{ [symbol]: SupportedAsset[] }` (arrays of length 1). */
/**
 * The asset catalogue, tolerant of instrument types we do not know yet.
 *
 * `/metadata/supported_assets` returns every listing on the venue — 547 of them today.
 * A strict enum over `instrument_type` makes the whole response all-or-nothing, so the
 * day Variational shipped six `swap` instruments (US100S, XAGS, USOILP, UKOILP, US500S,
 * XAUS) the entire catalogue stopped parsing and NOTHING could be traded, including
 * symbols whose own rows were perfectly valid.
 *
 * Failing closed is right for an order payload and wrong for a catalogue: a listing we
 * cannot model is one we simply must not trade, not a reason to stop trading everything.
 * Unparseable rows are dropped; `getAssetIndex` then just never offers that symbol, and
 * anything asking for it fails with a clear "lists no asset" rather than schema noise.
 */
export const supportedAssetsSchema = z.record(z.string(), z.array(z.unknown())).transform((raw) => {
  const out: Record<string, SupportedAsset[]> = {}
  for (const [symbol, rows] of Object.entries(raw)) {
    const kept: SupportedAsset[] = []
    for (const row of rows) {
      const parsed = supportedAssetSchema.safeParse(row)
      if (parsed.success) kept.push(parsed.data as SupportedAsset)
    }
    if (kept.length > 0) out[symbol] = kept
  }
  return out
})

export const riskLimitsSchema = z.looseObject({
  /** JSON NUMBER here, unlike almost everywhere else. */
  mark_price: z.number(),
  fdv_usd: z.number().nullish(),
  oi_limit_usd: z.number(),
  current_oi_usd: z.number(),
  skew_limit_usd: z.number(),
  current_skew_usd: z.number(),
  long_qty: decimalString,
  short_qty: decimalString,
})
export type RiskLimits = z.infer<typeof riskLimitsSchema>

export const openInterestSchema = z.looseObject({
  instrument: instrumentSchema,
  long_qty: decimalString,
  short_qty: decimalString,
})

export const fundingSchema = z.looseObject({
  predicted_funding_rate: decimalString,
  next_funding_time: timestampString,
  funding_interval_s: z.number(),
})
export type Funding = z.infer<typeof fundingSchema>

export const tierSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  total_volume_30d: decimalString,
  points_rate: decimalString,
})

/** `/metadata/stats` is large and mostly informational; kept loose on purpose. */
export const statsSchema = z.looseObject({
  total_volume_24h: decimalString.nullish(),
  cumulative_volume: decimalString.nullish(),
  tvl: decimalString.nullish(),
  open_interest: decimalString.nullish(),
  num_markets: z.number().nullish(),
  listings: z.array(z.unknown()).nullish(),
})

/* -------------------------------------------------------------------------- */
/* Settlement pools & sub-accounts                                            */
/* -------------------------------------------------------------------------- */

export const settlementPoolSchema = z.looseObject({
  id: numericLoose,
  pool_address: z.string(),
  status: z.union([z.enum(['open', 'pending', 'canceled']), z.string()]),
})
export type SettlementPool = z.infer<typeof settlementPoolSchema>

export const leverageTierSchema = z.looseObject({
  notional_lower_bound: decimalString,
  min_im: decimalString,
})

export const leverageSchema = z.record(
  z.string(),
  z.looseObject({
    current: decimalString,
    limits: z.array(leverageTierSchema),
  }),
)

export const conversionSchema = z.looseObject({
  conversion_id: z.string(),
  status: z.union([z.enum(['pending', 'confirmed', 'rejected']), z.string()]),
})
export type Conversion = z.infer<typeof conversionSchema>

/* -------------------------------------------------------------------------- */
/* WebSocket frames                                                           */
/* -------------------------------------------------------------------------- */

export const heartbeatSchema = z.looseObject({
  type: z.literal('heartbeat'),
  timestamp: timestampString,
})

export const pricingSchema = z.looseObject({
  /** The PERP MARK price, rounded to display precision on this feed. */
  price: decimalString,
  underlying_price: decimalString.nullish(),
  native_price: decimalString.nullish(),
  interest_rate: decimalString.nullish(),
  iv: decimalString.nullish(),
  delta: decimalString.nullish(),
  gamma: decimalString.nullish(),
  theta: decimalString.nullish(),
  vega: decimalString.nullish(),
  rho: decimalString.nullish(),
  /** Pricing-engine stamp. LAGS and REPEATS — dedupe on this, not on arrival. */
  timestamp: timestampString,
})
export type Pricing = z.infer<typeof pricingSchema>

export const priceFrameSchema = z.looseObject({
  /** `instrument_price:P-BTC-USDC-3600` */
  channel: z.string(),
  pricing: pricingSchema,
})

/** `/quotes/simple` over WS answers with the same body as the REST endpoint. */
export const quoteFrameSchema = quoteSchema

/** `{"error": "..."}` frames appear on the quote sockets. */
export const wsErrorFrameSchema = z.looseObject({ error: z.unknown() })

export const eventFrameSchema = z.looseObject({
  type: z.string(),
  data: z.unknown(),
})

/**
 * `/portfolio` frames are a MERGE over a REST-fetched base, not a snapshot.
 * Both fields are optional and there is no `type` discriminator.
 */
export const portfolioFrameSchema = z.looseObject({
  pool_portfolio_result: portfolioSchema.nullish(),
  positions: z.array(positionSchema).nullish(),
})

/* -------------------------------------------------------------------------- */
/* /events payloads (per the six handlers in chunks__CP61INuE.js)             */
/* -------------------------------------------------------------------------- */

export const tradeEventSchema = z.looseObject({
  source_rfq: z.string(),
  instrument: instrumentSchema,
  status: tradeStatusSchema.nullish(),
  side: wireSideSchema.nullish(),
  qty: decimalString.nullish(),
  price: decimalString.nullish(),
  id: z.string().nullish(),
  trade_type: tradeTypeSchema.nullish(),
  role: roleSchema.nullish(),
})

export const clearingEventSchema = z.looseObject({
  rfq_id: z.string(),
  taker_company: z.unknown().optional(),
  clearing_status: clearingStatusLoose.nullish(),
  failed_risk_checks: z.array(failedRiskCheckSchema).nullish(),
})

export const transferEventSchema = z.looseObject({
  transfer_type: transferTypeSchema,
  id: z.string().nullish(),
  status: tradeStatusSchema.nullish(),
  qty: decimalString.nullish(),
})

export const canceledOrderEventSchema = z.looseObject({
  order_id: z.string(),
  rfq_id: z.string().nullish(),
})

export const slippageWarningEventSchema = z.looseObject({
  rfq_id: z.string(),
  slippage: numericLoose.nullish(),
  timestamp: timestampString.nullish(),
})

export const allocationChangeEventSchema = z.looseObject({
  conversion_id: z.string(),
  status: z.string(),
})
