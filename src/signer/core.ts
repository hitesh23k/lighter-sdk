import { Logger } from "../logger";
import { LighterSignerError } from "../errors";

/**
 * Environment-neutral Lighter signing core.
 *
 * Lighter uses a ZK-rollup signature scheme (Poseidon hash over the Goldilocks field, Schnorr-style)
 * with no JavaScript implementation, so signing runs elliottech's official Go signer compiled to
 * WebAssembly. This module holds the ABI-level sign functions; loading the WASM is delegated to a
 * pluggable *instantiator* so the same signing code runs under Node (fs) and the browser (fetch).
 *
 * The Node aggregate `./signer` registers the fs instantiator on import; browser consumers call
 * `initLighterSigner` from `./signer/browser`. Both resolve to a {@link LighterWasmExports} of Go globals.
 */

/** Auth context handed to the Go client (CreateClient) before each signing call. */
export interface LighterClientContext {
    url: string;
    /** 304 = zk mainnet, 300 = testnet, 466324 = robinhood mainnet. */
    chainId: number;
    apiPrivateKey: string;
    accountIndex: number;
    apiKeyIndex: number;
}

export interface LighterCreateOrderInput {
    marketIndex: number;
    clientOrderIndex: number;
    /** Base amount as an integer scaled by the market's size_decimals (uint48; must be 0..2^48-1). */
    baseAmount: bigint | number;
    /** Price as an integer scaled by the market's price_decimals (must fit uint32). 0 = unset. */
    price: number;
    isAsk: boolean;
    orderType: number;
    timeInForce: number;
    reduceOnly: boolean;
    triggerPrice?: number;
    /** IOC/market orders must use 0 (NilOrderExpiry); GTT orders pass an epoch-ms expiry. */
    orderExpiry: number;
    /** Integrator (builder) fee routing; omit or 0 = Nil. Fee is a uint32 fraction of 1e6 (500 = 5 bps). */
    integratorAccountIndex?: number;
    integratorTakerFee?: number;
    integratorMakerFee?: number;
    nonce: number;
}

export interface LighterCancelOrderInput {
    marketIndex: number;
    orderIndex: number;
    nonce: number;
}

export interface LighterModifyOrderInput {
    marketIndex: number;
    /** The order index (id) to modify. */
    orderIndex: number;
    /** New base amount, integer scaled by size_decimals. */
    baseAmount: bigint | number;
    /** New price, integer scaled by price_decimals (uint32). */
    price: number;
    /** New trigger price for stop/tp orders, integer scaled by price_decimals (0 if none). */
    triggerPrice?: number;
    nonce: number;
}

export interface LighterUpdateLeverageInput {
    marketIndex: number;
    /** Integer initial-margin fraction (fraction/100 = margin%). */
    fraction: number;
    /** 0 = cross, 1 = isolated. */
    marginMode: number;
    nonce: number;
}

/** The signed transaction the REST client POSTs to /api/v1/sendTx. */
export interface LighterSignedTx {
    txType: number;
    txInfo: string;
    txHash?: string;
}

/** base_amount is a uint48 field in the order tx; the Go signer rejects anything larger. 2^48 - 1. */
const MAX_BASE_AMOUNT = 281474976710655;

type WasmFn = (...args: any[]) => any;
export interface LighterWasmExports {
    GenerateAPIKey: WasmFn;
    CreateClient: WasmFn;
    CreateAuthToken: WasmFn;
    SignCreateOrder: WasmFn;
    SignCancelOrder: WasmFn;
    SignCancelAllOrders: WasmFn;
    SignModifyOrder: WasmFn;
    SignUpdateLeverage: WasmFn;
    SignUpdateMargin: WasmFn;
    SignWithdraw: WasmFn;
    SignTransfer: WasmFn;
    SignCreateGroupedOrders: WasmFn;
    SignChangePubKey: WasmFn;
    SignApproveIntegrator: WasmFn;
}

/** A function that loads/instantiates the WASM signer and returns its exported Go globals. */
export type SignerInstantiator = () => Promise<LighterWasmExports>;

let instantiator: SignerInstantiator | null = null;
let signerPromise: Promise<LighterWasmExports> | null = null;

/** Register the environment-specific WASM loader. Resets any cached instance. Internal. */
export function _setSignerInstantiator(fn: SignerInstantiator): void {
    instantiator = fn;
    signerPromise = null;
}

/** Drop the cached signer instance so the next call re-instantiates. Internal. */
export function _resetSigner(): void {
    signerPromise = null;
}

/**
 * Validate that the Go runtime registered the expected signer globals and snapshot them. Called by each
 * instantiator after `go.run(instance)` + a tick. `g` is the global object the WASM wrote onto.
 */
export function finalizeExports(g: any): LighterWasmExports {
    if (typeof g.SignCreateOrder !== "function" || typeof g.CreateClient !== "function") {
        throw new LighterSignerError("LighterSigner::WASM module did not register the expected signer globals");
    }
    return {
        GenerateAPIKey: g.GenerateAPIKey,
        CreateClient: g.CreateClient,
        CreateAuthToken: g.CreateAuthToken,
        SignCreateOrder: g.SignCreateOrder,
        SignCancelOrder: g.SignCancelOrder,
        SignCancelAllOrders: g.SignCancelAllOrders,
        SignModifyOrder: g.SignModifyOrder,
        SignUpdateLeverage: g.SignUpdateLeverage,
        SignUpdateMargin: g.SignUpdateMargin,
        SignWithdraw: g.SignWithdraw,
        SignTransfer: g.SignTransfer,
        SignCreateGroupedOrders: g.SignCreateGroupedOrders,
        SignChangePubKey: g.SignChangePubKey,
        SignApproveIntegrator: g.SignApproveIntegrator,
    };
}

async function ensureSignerLoaded(): Promise<LighterWasmExports> {
    if (!instantiator) {
        throw new LighterSignerError(
            "LighterSigner::No signer loader registered. Import the SDK root (Node) or call initLighterSigner() " +
                "from '@hitesh23k/lighter-sdk/browser' before signing.",
        );
    }
    if (!signerPromise) {
        signerPromise = instantiator().catch((error) => {
            signerPromise = null; // allow retry after a fixed deploy / re-init
            throw error;
        });
    }
    return signerPromise;
}

/** Register/refresh the Go client for this account+key+chain before signing. */
function ensureClient(exports: LighterWasmExports, ctx: LighterClientContext): void {
    const result = exports.CreateClient(ctx.url, ctx.apiPrivateKey, ctx.chainId, ctx.apiKeyIndex, ctx.accountIndex);
    if (result && result.error) {
        throw new LighterSignerError(`LighterSigner::CreateClient::${result.error}`);
    }
}

function toSignedTx(result: any, methodName: string): LighterSignedTx {
    if (!result || typeof result !== "object") {
        throw new LighterSignerError(`LighterSigner::${methodName}::signer returned unexpected value: ${String(result)}`);
    }
    if (result.error) {
        throw new LighterSignerError(`LighterSigner::${methodName}::${result.error}`);
    }
    if (typeof result.txType !== "number" || typeof result.txInfo !== "string") {
        throw new LighterSignerError(`LighterSigner::${methodName}::signer returned unexpected shape: ${JSON.stringify(result)}`);
    }
    return { txType: result.txType, txInfo: result.txInfo, txHash: result.txHash };
}

function toSafeInt(value: bigint | number, field: string): number {
    const n = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isSafeInteger(n)) {
        throw new LighterSignerError(`LighterSigner::${field} exceeds safe integer range: ${value}`);
    }
    return n;
}

/**
 * Convert a scaled base amount to the number the WASM ABI expects, validating the uint48 field width the
 * signer enforces. Passing a string or BigInt to the WASM panics it, and a value above 2^48-1 is rejected
 * with an opaque error — so we surface a clear, actionable message here instead.
 */
function toBaseAmountArg(value: bigint | number): number {
    if (typeof value === "bigint") {
        if (value < 0n || value > BigInt(MAX_BASE_AMOUNT)) {
            throw new LighterSignerError(`LighterSigner::baseAmount out of range: ${value} (must be 0..${MAX_BASE_AMOUNT}, uint48)`);
        }
        return Number(value);
    }
    if (!Number.isInteger(value) || value < 0 || value > MAX_BASE_AMOUNT) {
        throw new LighterSignerError(`LighterSigner::baseAmount out of range: ${value} (must be an integer 0..${MAX_BASE_AMOUNT}, uint48)`);
    }
    return value;
}

export async function signCreateOrder(ctx: LighterClientContext, input: LighterCreateOrderInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(
        `LighterSigner::signCreateOrder::account=${ctx.accountIndex}, market=${input.marketIndex}, isAsk=${input.isAsk}, nonce=${input.nonce}`,
    );
    // Positional ABI (19 args): marketIndex, clientOrderIndex, baseAmount, price, isAsk, orderType,
    // timeInForce, reduceOnly, triggerPrice, orderExpiry, integratorAccountIndex, integratorTakerFee,
    // integratorMakerFee, selfTradeBehaviorMode, selfTradeEqualityMode, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignCreateOrder(
        input.marketIndex,
        input.clientOrderIndex,
        toBaseAmountArg(input.baseAmount),
        input.price,
        input.isAsk ? 1 : 0,
        input.orderType,
        input.timeInForce,
        input.reduceOnly ? 1 : 0,
        input.triggerPrice ?? 0,
        input.orderExpiry,
        input.integratorAccountIndex ?? 0, // integratorAccountIndex (0 = NilIntegratorIndex)
        input.integratorTakerFee ?? 0, // integratorTakerFee (uint32 fraction of 1e6)
        input.integratorMakerFee ?? 0, // integratorMakerFee (uint32 fraction of 1e6)
        0, // selfTradeBehaviorMode (SelfTradeBehaviorExpireMaker)
        0, // selfTradeEqualityMode (SelfTradeEqualityAccountIndex)
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signCreateOrder");
}

export interface LighterApiKeyPair {
    privateKey: string;
    publicKey: string;
}

/** Generate a fresh Ed25519 API keypair (for code-based provisioning; association still needs ChangePubKey). */
export async function generateApiKey(): Promise<LighterApiKeyPair> {
    const exports = await ensureSignerLoaded();
    const result = exports.GenerateAPIKey();
    if (!result || result.error || typeof result.privateKey !== "string" || typeof result.publicKey !== "string") {
        throw new LighterSignerError(`LighterSigner::generateApiKey::${result?.error || "unexpected response"}`);
    }
    return { privateKey: result.privateKey, publicKey: result.publicKey };
}

export interface LighterChangePubKeyInput {
    /** New API public key (hex) being registered at (accountIndex, apiKeyIndex). */
    publicKey: string;
    nonce: number;
    /** Skip nonce handling (for a brand-new api_key_index whose nonce bootstraps at 0). */
    skipNonce?: boolean;
}

export interface LighterChangePubKeyResult {
    txType: number;
    /** Signed tx JSON: the L2 self-signature (`Sig`) is set; `L1Sig` is empty and filled by the account owner's wallet. */
    txInfo: string;
    txHash?: string;
    /** The L1 message the account owner's EVM wallet must sign; its signature merges into `txInfo.L1Sig`. */
    messageToSign: string;
}

/**
 * Produce the L2 self-signed ChangePubKey tx that registers a new API public key. `ctx.apiPrivateKey` MUST
 * be the NEW key's private key (the self-signature proves control of the new key). The returned `txInfo`
 * has an empty `L1Sig`; the account owner's wallet signs `messageToSign` and that signature is merged into
 * `L1Sig` before submitting to /sendTx (tx_type 8).
 */
export async function signChangePubKey(ctx: LighterClientContext, input: LighterChangePubKeyInput): Promise<LighterChangePubKeyResult> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    // Positional ABI (5 args): pubKeyHex, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignChangePubKey(
        input.publicKey,
        input.skipNonce ? 1 : 0,
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    if (!result || typeof result !== "object") {
        throw new LighterSignerError(`LighterSigner::signChangePubKey::signer returned unexpected value: ${String(result)}`);
    }
    if (result.error) {
        throw new LighterSignerError(`LighterSigner::signChangePubKey::${result.error}`);
    }
    if (typeof result.txType !== "number" || typeof result.txInfo !== "string" || typeof result.messageToSign !== "string") {
        throw new LighterSignerError(`LighterSigner::signChangePubKey::signer returned unexpected shape: ${JSON.stringify(result)}`);
    }
    return { txType: result.txType, txInfo: result.txInfo, txHash: result.txHash, messageToSign: result.messageToSign };
}

export interface LighterApproveIntegratorInput {
    /** The integrator (partner) account_index that may collect fees on this account's orders. */
    integratorAccountIndex: number;
    /** Max perps taker fee the integrator may charge, as a uint32 fraction of 1e6 (500 = 5 bps). */
    maxPerpsTakerFee: number;
    maxPerpsMakerFee: number;
    /** Max spot fees (set 0 for perps-only integrators). */
    maxSpotTakerFee: number;
    maxSpotMakerFee: number;
    /** Absolute approval expiry in epoch MILLISECONDS (Lighter reads this field as ms, not seconds). */
    approvalExpiryMs: number;
    nonce: number;
}

export interface LighterApproveIntegratorResult {
    txType: number;
    /** Signed tx JSON: the L2 `Sig` is set; `L1Sig` is empty and filled by the account owner's wallet. */
    txInfo: string;
    txHash?: string;
    /** The L1 message the account owner's EVM wallet must personal_sign; merged into `txInfo.L1Sig`. */
    messageToSign: string;
}

/**
 * Produce the L2-signed ApproveIntegrator tx (tx_type 45) authorising `integratorAccountIndex` to charge
 * up to the given max fees on this account's orders until `approvalExpiryMs`. The integrator account is a
 * different L1 than the user, so Lighter REQUIRES an L1 signature: the returned `txInfo` has an empty
 * `L1Sig`, and the account owner's wallet personal_signs `messageToSign`; that signature is merged into
 * `L1Sig` before submitting to /sendTx. `ctx.apiPrivateKey` is the user's custodial (registered) API key.
 */
export async function signApproveIntegrator(ctx: LighterClientContext, input: LighterApproveIntegratorInput): Promise<LighterApproveIntegratorResult> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(
        `LighterSigner::signApproveIntegrator::account=${ctx.accountIndex}, integrator=${input.integratorAccountIndex}, nonce=${input.nonce}`,
    );
    // Positional ABI (10 args): integratorIndex, maxPerpsTakerFee, maxPerpsMakerFee, maxSpotTakerFee,
    // maxSpotMakerFee, approvalExpiry (ms), skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignApproveIntegrator(
        input.integratorAccountIndex,
        input.maxPerpsTakerFee,
        input.maxPerpsMakerFee,
        input.maxSpotTakerFee,
        input.maxSpotMakerFee,
        toSafeInt(input.approvalExpiryMs, "approvalExpiryMs"),
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    if (!result || typeof result !== "object") {
        throw new LighterSignerError(`LighterSigner::signApproveIntegrator::signer returned unexpected value: ${String(result)}`);
    }
    if (result.error) {
        throw new LighterSignerError(`LighterSigner::signApproveIntegrator::${result.error}`);
    }
    if (typeof result.txType !== "number" || typeof result.txInfo !== "string" || typeof result.messageToSign !== "string") {
        throw new LighterSignerError(`LighterSigner::signApproveIntegrator::signer returned unexpected shape: ${JSON.stringify(result)}`);
    }
    return { txType: result.txType, txInfo: result.txInfo, txHash: result.txHash, messageToSign: result.messageToSign };
}

export async function signModifyOrder(ctx: LighterClientContext, input: LighterModifyOrderInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signModifyOrder::account=${ctx.accountIndex}, market=${input.marketIndex}, orderIndex=${input.orderIndex}, nonce=${input.nonce}`);
    // Positional ABI (14 args): marketIndex, index, baseAmount, price, triggerPrice,
    // integratorAccountIndex, integratorTakerFee, integratorMakerFee, selfTradeBehaviorMode,
    // selfTradeEqualityMode, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignModifyOrder(
        input.marketIndex,
        input.orderIndex,
        toBaseAmountArg(input.baseAmount),
        input.price,
        input.triggerPrice ?? 0,
        0, // integratorAccountIndex (Nil)
        0, // integratorTakerFee (Nil)
        0, // integratorMakerFee (Nil)
        0, // selfTradeBehaviorMode
        0, // selfTradeEqualityMode
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signModifyOrder");
}

export async function signUpdateLeverage(ctx: LighterClientContext, input: LighterUpdateLeverageInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signUpdateLeverage::account=${ctx.accountIndex}, market=${input.marketIndex}, fraction=${input.fraction}, marginMode=${input.marginMode}`);
    // ABI (7 args): marketIndex, fraction, marginMode, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignUpdateLeverage(
        input.marketIndex,
        input.fraction,
        input.marginMode,
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signUpdateLeverage");
}

/** Mint a short-lived auth token for account-scoped GET reads (trades, fundings, …). */
export async function createAuthToken(ctx: LighterClientContext, deadlineUnixSec = 0): Promise<string> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    // ABI (3 args): deadline, apiKeyIndex, accountIndex. deadline=0 → default (~7h).
    const result = exports.CreateAuthToken(deadlineUnixSec, ctx.apiKeyIndex, ctx.accountIndex);
    if (!result || result.error || typeof result.authToken !== "string") {
        throw new LighterSignerError(`LighterSigner::createAuthToken::${result?.error || "unexpected response"}`);
    }
    return result.authToken;
}

export async function signCancelOrder(ctx: LighterClientContext, input: LighterCancelOrderInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signCancelOrder::account=${ctx.accountIndex}, market=${input.marketIndex}, orderIndex=${input.orderIndex}`);
    // Positional ABI (6 args): marketIndex, orderIndex, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignCancelOrder(
        input.marketIndex,
        input.orderIndex,
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signCancelOrder");
}

export interface LighterCancelAllOrdersInput {
    /** 0 = immediate, 1 = scheduled (at `time`), 2 = abort a scheduled cancel. Default immediate. */
    timeInForce?: number;
    /** Epoch-ms trigger for a scheduled cancel (timeInForce 1); 0/omitted for immediate. */
    time?: number;
    /** Market index to cancel, or 255 for ALL markets (the signer rejects other out-of-range values). */
    marketIndex: number;
    nonce: number;
}

/**
 * Sign an atomic CancelAllOrders tx (tx_type 16) — cancels every resting order (marketIndex 255) or all
 * orders in one market, in a single transaction. Preferred over cancelling order-by-order: one nonce, one
 * round trip, and no window for fills between per-order cancels.
 */
export async function signCancelAllOrders(ctx: LighterClientContext, input: LighterCancelAllOrdersInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signCancelAllOrders::account=${ctx.accountIndex}, market=${input.marketIndex}, tif=${input.timeInForce ?? 0}`);
    // Positional ABI (7 args): timeInForce, time, cancelAllMarketIndex, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignCancelAllOrders(
        input.timeInForce ?? 0,
        toSafeInt(input.time ?? 0, "time"),
        input.marketIndex,
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signCancelAllOrders");
}

export interface LighterUpdateMarginInput {
    marketIndex: number;
    /** USDC amount as an integer scaled to USDC decimals. */
    usdcAmount: bigint | number;
    /** 0 = add margin (isolated), 1 = remove margin. */
    direction: number;
    nonce: number;
}

/** Sign an add/remove isolated-margin tx (tx_type 29) for a market. */
export async function signUpdateMargin(ctx: LighterClientContext, input: LighterUpdateMarginInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signUpdateMargin::account=${ctx.accountIndex}, market=${input.marketIndex}, direction=${input.direction}`);
    // ABI (7 args): marketIndex, usdcAmount, direction, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignUpdateMargin(
        input.marketIndex,
        toSafeInt(input.usdcAmount, "usdcAmount"),
        input.direction,
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signUpdateMargin");
}

export interface LighterWithdrawInput {
    /** Asset index (1-based; USDC = 1). Defaults to 1. */
    assetIndex?: number;
    /** 0 = standard, 1 = fast. Defaults to 0. */
    routeType?: number;
    /** Amount as an integer scaled to the asset's decimals (uint64). */
    amount: bigint | number;
    nonce: number;
}

/** Sign a withdrawal tx (tx_type 13) moving funds out of the L2 account to the L1 owner. */
export async function signWithdraw(ctx: LighterClientContext, input: LighterWithdrawInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signWithdraw::account=${ctx.accountIndex}, asset=${input.assetIndex ?? 1}, amount=${input.amount}`);
    // ABI (7 args): assetIndex, routeType, amount, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignWithdraw(
        input.assetIndex ?? 1,
        input.routeType ?? 0,
        toSafeInt(input.amount, "amount"),
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signWithdraw");
}

export interface LighterTransferInput {
    toAccountIndex: number;
    /** Asset index (1-based; USDC = 1). Defaults to 1. */
    assetIndex?: number;
    fromRouteType?: number;
    toRouteType?: number;
    /** Amount as an integer scaled to the asset's decimals. */
    amount: bigint | number;
    /** USDC fee (scaled). Defaults to 0. */
    usdcFee?: bigint | number;
    /** 32-byte memo as hex (64 hex chars, or 66 with `0x`). Defaults to a zero memo. */
    memo?: string;
    nonce: number;
}

/** Sign a transfer tx (tx_type 12) moving funds to another Lighter account. */
export async function signTransfer(ctx: LighterClientContext, input: LighterTransferInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signTransfer::account=${ctx.accountIndex}, to=${input.toAccountIndex}, amount=${input.amount}`);
    // ABI (11 args): toAccountIndex, assetIndex, fromRouteType, toRouteType, amount, usdcFee, memo,
    // skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignTransfer(
        input.toAccountIndex,
        input.assetIndex ?? 1,
        input.fromRouteType ?? 0,
        input.toRouteType ?? 0,
        toSafeInt(input.amount, "amount"),
        toSafeInt(input.usdcFee ?? 0, "usdcFee"),
        input.memo ?? "0x" + "00".repeat(32),
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signTransfer");
}

/** One leg of a grouped order. Trigger/child legs (TP/SL) use baseAmount 0 (they close the main fill). */
export interface LighterGroupedOrder {
    marketIndex: number;
    clientOrderIndex: number;
    /** Integer scaled by size_decimals (uint48). 0 for TP/SL legs in an OTOCO bracket. */
    baseAmount: bigint | number;
    /** Integer scaled by price_decimals (uint32). Worst-case bound for market/trigger legs. */
    price: number;
    isAsk: boolean;
    orderType: number;
    timeInForce: number;
    reduceOnly: boolean;
    triggerPrice?: number;
    orderExpiry: number;
}

export interface LighterCreateGroupedOrdersInput {
    /** LighterConstant.GROUPING_TYPE: OTO (1), OCO (2), or OTOCO (3, a bracket). */
    groupingType: number;
    orders: LighterGroupedOrder[];
    integratorAccountIndex?: number;
    integratorTakerFee?: number;
    integratorMakerFee?: number;
    nonce: number;
}

/**
 * Sign a grouped-orders tx (tx_type 28) — OTO/OCO/OTOCO. The OTOCO form is a bracket: a main entry order
 * plus reduce-only take-profit and stop-loss legs (their baseAmount is 0; they close whatever the main fills).
 */
export async function signCreateGroupedOrders(ctx: LighterClientContext, input: LighterCreateGroupedOrdersInput): Promise<LighterSignedTx> {
    const exports = await ensureSignerLoaded();
    ensureClient(exports, ctx);
    Logger.debug(`LighterSigner::signCreateGroupedOrders::account=${ctx.accountIndex}, grouping=${input.groupingType}, legs=${input.orders.length}`);
    // The WASM expects an array of PascalCase order objects; marshal + validate each base amount (uint48).
    const orders = input.orders.map((o) => ({
        MarketIndex: o.marketIndex,
        ClientOrderIndex: o.clientOrderIndex,
        BaseAmount: toBaseAmountArg(o.baseAmount),
        Price: o.price,
        IsAsk: o.isAsk ? 1 : 0,
        Type: o.orderType,
        TimeInForce: o.timeInForce,
        ReduceOnly: o.reduceOnly ? 1 : 0,
        TriggerPrice: o.triggerPrice ?? 0,
        OrderExpiry: o.orderExpiry,
    }));
    // ABI (11 args): groupingType, orders[], integratorAccountIndex, integratorTakerFee, integratorMakerFee,
    // selfTradeBehaviorMode, selfTradeEqualityMode, skipNonce, nonce, apiKeyIndex, accountIndex.
    const result = exports.SignCreateGroupedOrders(
        input.groupingType,
        orders,
        input.integratorAccountIndex ?? 0,
        input.integratorTakerFee ?? 0,
        input.integratorMakerFee ?? 0,
        0, // selfTradeBehaviorMode
        0, // selfTradeEqualityMode
        0, // skipNonce
        input.nonce,
        ctx.apiKeyIndex,
        ctx.accountIndex,
    );
    return toSignedTx(result, "signCreateGroupedOrders");
}
