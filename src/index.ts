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
    type LighterSignedTx,
    type LighterApiKeyPair,
    type LighterChangePubKeyInput,
    type LighterChangePubKeyResult,
    type LighterApproveIntegratorInput,
    type LighterApproveIntegratorResult,
} from "./signer/signer";

// High-level venue-aware convenience client
export { default as LighterClient } from "./client";
export type {
    LighterClientConfig,
    LighterMarketMeta,
    OrderSide,
    PlaceMarketOrderParams,
    PlaceLimitOrderParams,
} from "./client";

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
