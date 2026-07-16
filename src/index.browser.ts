/**
 * Browser entry for @hitesh23k/lighter-sdk. Identical surface to the Node entry, minus the fs-based signer
 * loader: instead of auto-registering a filesystem loader, browser consumers call `initLighterSigner(...)`
 * with the WASM + wasm_exec URLs (or bytes). The REST and WebSocket clients are unchanged — they use the
 * global `fetch` and `WebSocket`, both available in the browser.
 *
 * This module imports NO Node builtins (`fs`/`path`/`module`), so bundlers produce a clean browser build.
 */
export { setLogger, type LighterLogger } from "./logger";

// Browser signer: init loader + the environment-neutral signing API from core.
export { initLighterSigner, type BrowserSignerInit } from "./signer/browser";
export {
    signCreateOrder,
    signCancelOrder,
    signModifyOrder,
    signUpdateLeverage,
    signChangePubKey,
    signApproveIntegrator,
    createAuthToken,
    generateApiKey,
    type LighterClientContext,
    type LighterCreateOrderInput,
    type LighterCancelOrderInput,
    type LighterModifyOrderInput,
    type LighterUpdateLeverageInput,
    type LighterSignedTx,
    type LighterApiKeyPair,
    type LighterChangePubKeyInput,
    type LighterChangePubKeyResult,
    type LighterApproveIntegratorInput,
    type LighterApproveIntegratorResult,
} from "./signer/core";

// High-level venue-aware convenience client
export { default as LighterClient } from "./client";
export type {
    LighterClientConfig,
    LighterMarketMeta,
    OrderSide,
    PlaceMarketOrderParams,
    PlaceLimitOrderParams,
} from "./client";

// REST client + protocol constants + fixed-point helpers (fetch-based, browser-safe)
export { default as LighterRestClient } from "./rest/client";
export { default as LighterConstant } from "./constants";
export { default as LighterHelper } from "./helpers";

// WebSocket streaming client (uses the browser's global WebSocket)
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
