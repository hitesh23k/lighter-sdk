/**
 * @hitesh23k/lighter-sdk — TypeScript/JavaScript SDK for Lighter (zkLighter) and Robinhood-Chain Lighter.
 *
 * Surface so far: the WASM-backed zk signer, the REST client (read + signed write path), protocol
 * constants and fixed-point helpers, and an injectable logger. WebSocket streams and a high-level
 * venue-aware convenience client land in later phases.
 */
export { setLogger, type LighterLogger } from "./logger";

export {
    // signing entrypoints
    signCreateOrder,
    signCancelOrder,
    signCancelAllOrders,
    signModifyOrder,
    signUpdateLeverage,
    signUpdateMargin,
    signWithdraw,
    signTransfer,
    signCreateGroupedOrders,
    signChangePubKey,
    signApproveIntegrator,
    createAuthToken,
    generateApiKey,
    // artifact-location control (for bundled hosts)
    setSignerArtifactDir,
    // signer types
    type LighterClientContext,
    type LighterCreateOrderInput,
    type LighterCancelOrderInput,
    type LighterCancelAllOrdersInput,
    type LighterModifyOrderInput,
    type LighterUpdateLeverageInput,
    type LighterUpdateMarginInput,
    type LighterWithdrawInput,
    type LighterTransferInput,
    type LighterGroupedOrder,
    type LighterCreateGroupedOrdersInput,
    type LighterSignedTx,
    type LighterApiKeyPair,
    type LighterChangePubKeyInput,
    type LighterChangePubKeyResult,
    type LighterApproveIntegratorInput,
    type LighterApproveIntegratorResult,
} from "./signer/signer";

// Typed error classes
export { LighterError, LighterApiError, LighterSignerError, LighterValidationError } from "./errors";

// High-level venue-aware convenience client
export { default as LighterClient } from "./client";
export type {
    LighterClientConfig,
    LighterMarketMeta,
    OrderSide,
    PlaceMarketOrderParams,
    PlaceLimitOrderParams,
    PlaceBracketOrderParams,
} from "./client";

// Onboarding (associate an API key with an account so you can trade)
export { default as LighterOnboarding } from "./onboarding";
export type { LighterOnboardingConfig, PendingApiKeyRegistration } from "./onboarding";

// REST client + protocol constants + fixed-point helpers
export { default as LighterRestClient } from "./rest/client";
export { default as LighterConstant } from "./constants";
export { default as LighterHelper } from "./helpers";

// WebSocket streaming client
export { default as LighterWs } from "./ws/client";
export type {
    LighterWsConfig,
    LighterWsMessage,
    LighterWsEvent,
    LighterWsHandler,
    LighterChannelHandler,
    WebSocketCtor,
    WebSocketLike,
    Unsubscribe,
} from "./ws/types";

// API / config types
export type {
    LighterVenue,
    LighterCandle,
    LighterCandlesResponse,
    LighterRestClientConfig,
    LighterIntegratorConfig,
    LighterSignerContext,
    LighterOrderBookDetail,
    LighterOrderBookDetailsResponse,
    LighterFundingRate,
    LighterFundingRatesResponse,
    LighterPosition,
    LighterAccount,
    LighterAccountResponse,
    LighterNextNonceResponse,
    LighterSendTxResponse,
    LighterTrade,
    LighterAccountFill,
    LighterPositionFunding,
    LighterTokenListItem,
    LighterCreateMarketOrderParams,
    LighterCreateLimitOrderParams,
    LighterActiveOrder,
    LighterApiKeyEntry,
} from "./types";
