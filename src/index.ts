/**
 * variational-trading-api — an unofficial, reverse-engineered, typed client for the
 * Variational Omni trading API.
 *
 * Everything that knows how Omni's wire format works lives in this package: exact field
 * spellings, decimal-string precision, instrument encoding, zod validation on every
 * response. Callers get typed objects and a two-valued `Side`.
 *
 * Quick start:
 *
 * ```ts
 * const client = new OmniClient({ cookies: cookieHeader, dryRun: true })
 * await client.getMe()                                  // mints the WebSocket JWT
 * const positions = await client.getPositions()
 *
 * const prices = new PricesFeed({ wsBaseUrl: DEFAULT_WS_URL })
 * prices.on('mark', (tick) => console.log(tick.key, tick.price))
 * prices.subscribe([{ symbol: 'BTC' }])
 * prices.start()
 * ```
 *
 * The default is `dryRun: true`: a mutating request is refused until you opt in,
 * explicitly, with `dryRun: false`.
 */

/* Client ------------------------------------------------------------------ */
export {
  type AcceptQuotePayload,
  type BracketPayload,
  DEFAULT_API_BASE,
  type LimitOrderPayload,
  type MarketOrderPayload,
  OmniClient,
  type OmniClientOptions,
  type OrderListQuery,
  PUBLIC_STATS_BASE,
  QUOTE_MAX_AGE_MS,
  type TokenClaims,
} from './client.js'
/* Transport --------------------------------------------------------------- */
export {
  type CurlTransportOptions,
  createCurlTransport,
  curlTransport,
} from './curl-transport.js'
/* Errors ------------------------------------------------------------------ */
export {
  ApiError,
  AuthError,
  DryRunViolation,
  InvalidRequestError,
  isApiError,
  isAuthError,
  isOmniError,
  isRateLimitError,
  isSchemaDriftError,
  OmniError,
  RAW_BODY_LIMIT,
  RateLimitError,
  SchemaDriftError,
  TransportError,
} from './errors.js'
export {
  BROWSER_USER_AGENT,
  CookieJar,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  type DryRunMode,
  type FetchLike,
  type LogFn,
  type Logger,
  noopLogger,
  OmniHttp,
  type RequestSpec,
  type RetryPolicy,
  type TransportOptions,
} from './http.js'

/* Instrument encoding ----------------------------------------------------- */
export {
  type AssetLike,
  asInstrumentKey,
  assetQuery,
  CONTRACT_FUNDING_INTERVAL_S,
  type InstrumentInput,
  type InstrumentKey,
  type InstrumentObject,
  instrumentDisplay,
  instrumentKey,
  instrumentObject,
  instrumentQuery,
  parseInstrumentKey,
  positionKey,
  SETTLEMENT_ASSET,
  splitPositionKey,
} from './instrument.js'

/* Precision --------------------------------------------------------------- */
export {
  countDecimals,
  formatPrice,
  formatQty,
  MAX_PRICE_DECIMALS,
  meetsMinNotional,
  type QtyLimit,
  type QtyValidation,
  qtyDecimalsFromTick,
  stripTrailingZeros,
  toPlainString,
  truncateToDecimals,
  validateQty,
} from './precision.js'
/* Rate limiting ----------------------------------------------------------- */
export {
  type BucketConfig,
  type BucketSnapshot,
  DEFAULT_RATE_LIMITS,
  type RateClass,
  RateLimiter,
  type RateLimiterConfig,
} from './rate-limit.js'
export type {
  AssetClass,
  ClearingStatus,
  Conversion,
  DexTokenDetails,
  Funding,
  InstrumentType,
  InstrumentWire,
  IsolatedSubAccount,
  LoginResult,
  Me,
  MetadataConfig,
  Order,
  OrderStatus,
  OrderType,
  Page,
  Portfolio,
  Position,
  Pricing,
  Quote,
  RfqAck,
  RiskLimits,
  SettlementPool,
  SupportedAsset,
  Trade,
  Transfer,
  WireSide,
} from './schemas.js'
/* Schemas and inferred wire types ----------------------------------------- */
export * as schemas from './schemas.js'
/* Wire <-> domain --------------------------------------------------------- */
export {
  bpsToFraction,
  closingSide,
  fractionToBps,
  fromWireSide,
  isBenignReject,
  isRejected,
  MAX_SLIPPAGE_FRACTION,
  parseTimestamp,
  sideFromQty,
  toExchangePosition,
  toWireSide,
} from './wire.js'
/* WebSocket feeds --------------------------------------------------------- */
export * from './ws/index.js'

/** Default WebSocket host. */
export const DEFAULT_WS_URL = 'wss://omni-ws-server.prod.ap-northeast-1.variational.io'

export type { BrowserTransportOptions } from './browser-transport.js'
export {
  createBrowserTransport,
  purgeNonSessionCookies,
  setBrowserCookies,
} from './browser-transport.js'
/*
 * Session lifecycle: sign in with an Ethereum key via SIWE and get back the cookies and
 * token every other call needs. See docs/AUTH.md.
 */
export { mintSessionViaSiwe } from './session.js'
export type { SessionBundle } from './session-bundle.js'
export { addressFromPrivateKey, personalSign } from './siwe.js'
/* Domain vocabulary ------------------------------------------------------ */
export type {
  ExchangePosition,
  InstrumentId,
  MarkTick,
  PositionKey,
  Price,
  Qty,
  Side,
  SubAccount,
  Timestamp,
} from './types.js'
