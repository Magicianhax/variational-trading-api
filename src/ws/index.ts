/** WebSocket layer barrel. */

export { Emitter, type Listener, type Unsubscribe } from './emitter.js'
export { PricesFeed, type PricesFeedEvents, type PricesFeedOptions } from './prices.js'
export {
  type AllocationChangeEvent,
  type CanceledOrderEvent,
  type ClearingEvent,
  EventsFeed,
  type EventsFeedEvents,
  PortfolioFeed,
  type PortfolioFeedEvents,
  type PrivateFeedOptions,
  type SlippageWarningEvent,
  type TradeEvent,
  type TransferEvent,
} from './private.js'
export {
  QuotesFeed,
  type QuotesFeedEvents,
  type QuotesFeedOptions,
  QuotesFeedPool,
} from './quotes.js'
export {
  ManagedSocket,
  type ManagedSocketEvents,
  type ManagedSocketOptions,
  SOCKET_OPEN,
  type SocketState,
  type WebSocketFactory,
  type WebSocketLike,
} from './socket.js'
