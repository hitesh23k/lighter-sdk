import { Logger } from "../logger";
import LighterConstant from "../constants";
import LighterHelper from "../helpers";
// Import the pure sign functions from core (NOT the Node aggregate) so the REST client carries no fs
// loader — the loader is registered by whichever entry is used (Node index, or initLighterSigner in browser).
import {
    signCreateOrder,
    signCancelOrder,
    signCancelAllOrders,
    signModifyOrder,
    signUpdateLeverage,
    signApproveIntegrator,
    createAuthToken,
    type LighterClientContext,
} from "../signer/core";
import NonceManager from "./nonce-manager";
import {
    LighterRestClientConfig,
    LighterIntegratorConfig,
    LighterSignerContext,
    LighterOrderBookDetail,
    LighterOrderBookDetailsResponse,
    LighterFundingRate,
    LighterFundingRatesResponse,
    LighterAccount,
    LighterAccountResponse,
    LighterNextNonceResponse,
    LighterSendTxResponse,
    LighterTrade,
    LighterPositionFunding,
    LighterTokenListItem,
    LighterCreateMarketOrderParams,
    LighterCreateLimitOrderParams,
    LighterActiveOrder,
    LighterApiKeyEntry,
    LighterPosition,
} from "../types";

/**
 * REST client for a single Lighter venue (zk or robinhood) + network. Covers the public read endpoints,
 * account-scoped authed reads, and the signed write path (/sendTx). Signing is delegated to the WASM
 * signer; the caller passes a {@link LighterSignerContext} (decrypted API key + account/key indices) per
 * write call, so the client holds no secrets.
 */
export default class LighterRestClient {
    private readonly baseUrl: string;
    private readonly chainId: number;
    private readonly venue: string;
    private readonly isMainnet: boolean;
    private readonly integrator: LighterIntegratorConfig | null;
    /** Cached auth tokens per account+key; refreshed before expiry. */
    private authTokenCache: Map<string, { token: string; expiresAtMs: number }> = new Map();
    private static readonly AUTH_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // refresh well before the ~7h server deadline
    /** Serializes signed writes per account+key and sequences their nonces (see NonceManager). */
    private readonly nonces: NonceManager;

    constructor(config: LighterRestClientConfig = {}) {
        const venue = config.venue || LighterConstant.VENUE.ZK;
        const isMainnet = config.isMainnet !== false; // default mainnet
        const resolved = LighterConstant.resolveVenue(venue, isMainnet);
        // baseUrl override is honoured (rare); the signer chainId always comes from the venue + network.
        this.baseUrl = config.baseUrl || resolved.baseUrl;
        this.chainId = resolved.chainId;
        this.venue = venue;
        this.isMainnet = isMainnet;
        this.integrator = config.integrator || null;
        this.nonces = new NonceManager((accountIndex, apiKeyIndex) => this.getNextNonce(accountIndex, apiKeyIndex));
    }

    private clientContext(ctx: LighterSignerContext): LighterClientContext {
        return {
            url: this.baseUrl,
            chainId: this.chainId,
            apiPrivateKey: ctx.apiPrivateKey,
            accountIndex: ctx.accountIndex,
            apiKeyIndex: ctx.apiKeyIndex,
        };
    }

    private async authToken(ctx: LighterSignerContext): Promise<string> {
        const key = `${ctx.accountIndex}:${ctx.apiKeyIndex}`;
        const cached = this.authTokenCache.get(key);
        if (cached && cached.expiresAtMs > Date.now()) {
            return cached.token;
        }
        const token = await createAuthToken(this.clientContext(ctx));
        this.authTokenCache.set(key, { token, expiresAtMs: Date.now() + LighterRestClient.AUTH_TOKEN_TTL_MS });
        return token;
    }

    // ==================== READ PATH (no signer) ====================

    public async getOrderBookDetails(): Promise<LighterOrderBookDetail[]> {
        const res = await this.getJson<LighterOrderBookDetailsResponse>(
            "getOrderBookDetails",
            LighterConstant.ENDPOINTS.orderBookDetails,
        );
        return res.order_book_details || [];
    }

    /** Full token list incl. asset_type (CRYPTO/RWA) and categories. Public, no auth. */
    public async getTokenList(): Promise<LighterTokenListItem[]> {
        const res = await this.getJson<{ code?: number; tokens: LighterTokenListItem[] }>(
            "getTokenList",
            LighterConstant.ENDPOINTS.tokenlist,
        );
        return res.tokens || [];
    }

    /**
     * Funding rates. The `/funding-rates` endpoint AGGREGATES several venues (binance, bybit, hyperliquid,
     * lighter), so this defaults to Lighter's own rows only — otherwise a naive `find(symbol)` can return
     * another exchange's rate. Pass `{ exchange: null }` for the raw aggregated set, or another venue name.
     */
    public async getFundingRates(options: { exchange?: string | null } = {}): Promise<LighterFundingRate[]> {
        const res = await this.getJson<LighterFundingRatesResponse>(
            "getFundingRates",
            LighterConstant.ENDPOINTS.fundingRates,
        );
        const rows = res.funding_rates || [];
        const exchange = options.exchange === undefined ? LighterConstant.NETWORK : options.exchange;
        if (exchange === null) return rows;
        return rows.filter((r) => String(r.exchange || "").toLowerCase() === String(exchange).toLowerCase());
    }

    /** Raw aggregated funding rates across ALL venues (binance/bybit/hyperliquid/lighter). */
    public async getAllFundingRates(): Promise<LighterFundingRate[]> {
        return this.getFundingRates({ exchange: null });
    }

    public async getAccount(accountIndex: number): Promise<LighterAccount | null> {
        const res = await this.getJson<LighterAccountResponse>(
            "getAccount",
            LighterConstant.ENDPOINTS.account,
            { by: "index", value: accountIndex },
        );
        return res.account || res.accounts?.[0] || null;
    }

    public async getAccountsByL1Address(l1Address: string): Promise<LighterAccount[]> {
        // The endpoint returns `sub_accounts` (whose id field is `index`, not `account_index`); `accounts`
        // is a defensive fallback. Case-insensitive on the L1 address.
        const res = await this.getJson<LighterAccountResponse & { sub_accounts?: LighterAccount[] }>(
            "getAccountsByL1Address",
            LighterConstant.ENDPOINTS.accountsByL1Address,
            { l1_address: l1Address },
        );
        return res.sub_accounts || res.accounts || [];
    }

    /**
     * The account's registered API keys. `api_key_index=255` returns all slots. Used to pick a free
     * programmatic slot (>= 4). Public read (returns public keys, no secrets).
     */
    public async getApiKeys(accountIndex: number): Promise<LighterApiKeyEntry[]> {
        const res = await this.getJson<{ code?: number; api_keys?: LighterApiKeyEntry[]; apikeys?: LighterApiKeyEntry[] }>(
            "getApiKeys",
            LighterConstant.ENDPOINTS.apikeys,
            { account_index: accountIndex, api_key_index: 255 },
        );
        return res.api_keys || res.apikeys || [];
    }

    public async getPositions(accountIndex: number): Promise<LighterPosition[]> {
        const account = await this.getAccount(accountIndex);
        return account?.positions || [];
    }

    /** Account-scoped fills. Requires auth (minted per account+key and cached). */
    public async getAccountTrades(
        ctx: LighterSignerContext,
        params: { marketId?: number; limit?: number; orderIndex?: number } = {},
    ): Promise<LighterTrade[]> {
        const token = await this.authToken(ctx);
        const query: Record<string, unknown> = {
            sort_by: "timestamp",
            sort_dir: "desc",
            limit: params.limit ?? 50,
            account_index: ctx.accountIndex,
            type: "trade",
        };
        if (params.marketId !== undefined) query.market_id = params.marketId;
        if (params.orderIndex !== undefined) query.order_index = params.orderIndex;
        const res = await this.getJsonAuthed<{ code?: number; trades: LighterTrade[] }>(
            "getAccountTrades",
            LighterConstant.ENDPOINTS.trades,
            token,
            query,
        );
        return res.trades || [];
    }

    /**
     * Resting (active) orders for an account. Requires auth. `marketId` defaults to all markets.
     * Used to resolve a user-facing order id -> `order_index` (+ market) for cancel/modify, and to
     * enumerate orders for a cancel-all.
     */
    public async getActiveOrders(
        ctx: LighterSignerContext,
        params: { marketId?: number } = {},
    ): Promise<LighterActiveOrder[]> {
        const token = await this.authToken(ctx);
        const query: Record<string, unknown> = { account_index: ctx.accountIndex };
        if (params.marketId !== undefined) query.market_id = params.marketId;
        const res = await this.getJsonAuthed<{ code?: number; orders?: LighterActiveOrder[]; active_orders?: LighterActiveOrder[] }>(
            "getActiveOrders",
            LighterConstant.ENDPOINTS.accountActiveOrders,
            token,
            query,
        );
        return res.orders || res.active_orders || [];
    }

    /**
     * VERIFY ON-CHAIN that the account has approved the configured integrator. Lighter exposes NO read API
     * for integrator approvals (not in accountLimits/account, no dedicated endpoint), so we PROBE: attempt a
     * tiny far-from-market resting limit carrying the integrator fee. Lighter rejects it with "integrator is
     * not approved" for an unapproved / insufficient-max-fee / expired account, and accepts it otherwise
     * (Lighter itself checks the approved account, max fee and expiry). On acceptance we immediately cancel
     * the canary and return true. Non-integrator errors are rethrown (indeterminate).
     */
    public async probeIntegratorApproved(ctx: LighterSignerContext): Promise<boolean> {
        if (!this.integrator) {
            throw new Error("Lighter integrator is not configured for this client");
        }
        const details = await this.getOrderBookDetails();
        const market = details.find((d) => String(d.symbol || "").toUpperCase() === "BTC") || details[0];
        if (!market) throw new Error("No market available to probe integrator approval");

        const baseAmount = LighterHelper.toBaseAmount(Number(market.min_base_amount), market.size_decimals);
        // Far below mid so the canary rests without filling; carries the integrator fee so Lighter validates approval.
        const price = Number(LighterHelper.toPriceInt(Number(market.last_trade_price) * 0.5, market.price_decimals));
        const clientOrderIndex = (Date.now() * 1000) % LighterConstant.MAX_CLIENT_ORDER_INDEX;

        try {
            await this.createLimitOrder(ctx, {
                marketIndex: market.market_id,
                baseAmount,
                price,
                isAsk: false,
                clientOrderIndex,
                timeInForce: "gtc",
                applyIntegratorFee: true,
            });
        } catch (error: any) {
            if (/integrator is not approved|integrator.*not.*approv/i.test(String(error?.message || ""))) return false;
            throw error;
        }

        // Accepted => approved. Best-effort cancel the resting canary.
        try {
            const active = await this.getActiveOrders(ctx, { marketId: market.market_id });
            const canary = active.find((o) => String(o.client_order_index) === String(clientOrderIndex));
            if (canary && Number.isFinite(Number(canary.order_index))) {
                await this.cancelOrder(ctx, {
                    marketIndex: Number(canary.market_index ?? canary.market_id ?? market.market_id),
                    orderIndex: Number(canary.order_index),
                });
            }
        } catch (cleanupError: any) {
            Logger.warn(`LighterRestClient::probeIntegratorApproved::canary cleanup failed: ${cleanupError?.message}`);
        }
        return true;
    }

    /** An account's realized funding payments per position. Requires auth. */
    public async getPositionFunding(
        ctx: LighterSignerContext,
        params: { marketId?: number; limit?: number; startTimestamp?: number; endTimestamp?: number } = {},
    ): Promise<LighterPositionFunding[]> {
        const token = await this.authToken(ctx);
        const query: Record<string, unknown> = {
            account_index: ctx.accountIndex,
            limit: params.limit ?? 100,
        };
        if (params.marketId !== undefined) query.market_id = params.marketId;
        if (params.startTimestamp !== undefined) query.start_timestamp = params.startTimestamp;
        if (params.endTimestamp !== undefined) query.end_timestamp = params.endTimestamp;
        const res = await this.getJsonAuthed<{ code?: number; position_fundings: LighterPositionFunding[] }>(
            "getPositionFunding",
            LighterConstant.ENDPOINTS.positionFunding,
            token,
            query,
        );
        return res.position_fundings || [];
    }

    /**
     * OHLCV candles. All of market_id, resolution, start/end_timestamp (ms) and count_back are
     * required by the API. Response: { code, r, c: [{ t,o,h,l,c,v,V,i }] } (max 500 per call).
     */
    public async getCandles(params: {
        market_id: number;
        resolution: string;
        start_timestamp: number;
        end_timestamp: number;
        count_back: number;
        set_timestamp_to_end?: boolean;
    }): Promise<any> {
        return this.getJson<any>("getCandles", LighterConstant.ENDPOINTS.candles, params);
    }

    /**
     * Mark-price OHLCV candles. Mark price (not last trade) drives margin and liquidation, so use these for
     * risk math. Same required params as {@link getCandles}.
     */
    public async getMarkPriceCandles(params: {
        market_id: number;
        resolution: string;
        start_timestamp: number;
        end_timestamp: number;
        count_back: number;
        set_timestamp_to_end?: boolean;
    }): Promise<any> {
        return this.getJson<any>("getMarkPriceCandles", LighterConstant.ENDPOINTS.markPriceCandles, params);
    }

    /** Full order books (levels) for all markets, or one market when `marketId` is given. */
    public async getOrderBooks(marketId?: number): Promise<any> {
        return this.getJson<any>(
            "getOrderBooks",
            LighterConstant.ENDPOINTS.orderBooks,
            marketId !== undefined ? { market_id: marketId } : undefined,
        );
    }

    /** Public recent trades for a market (no auth). */
    public async getRecentTrades(marketId: number, limit = 100): Promise<LighterTrade[]> {
        const res = await this.getJson<{ code?: number; trades?: LighterTrade[] }>(
            "getRecentTrades",
            LighterConstant.ENDPOINTS.recentTrades,
            { market_id: marketId, limit },
        );
        return res.trades || [];
    }

    /** Account tier + trading limits (rate/volume/size caps). Requires auth (account-scoped). */
    public async getAccountLimits(ctx: LighterSignerContext): Promise<any> {
        const token = await this.authToken(ctx);
        return this.getJsonAuthed<any>("getAccountLimits", LighterConstant.ENDPOINTS.accountLimits, token, {
            account_index: ctx.accountIndex,
        });
    }

    /**
     * Closed / historical (inactive) orders for an account — needed for reconciliation. Requires auth.
     * `marketId` defaults to all markets.
     */
    public async getInactiveOrders(
        ctx: LighterSignerContext,
        params: { marketId?: number; limit?: number } = {},
    ): Promise<LighterActiveOrder[]> {
        const token = await this.authToken(ctx);
        const query: Record<string, unknown> = { account_index: ctx.accountIndex, limit: params.limit ?? 100 };
        if (params.marketId !== undefined) query.market_id = params.marketId;
        const res = await this.getJsonAuthed<{ code?: number; orders?: LighterActiveOrder[] }>(
            "getInactiveOrders",
            LighterConstant.ENDPOINTS.accountInactiveOrders,
            token,
            query,
        );
        return res.orders || [];
    }

    public async getNextNonce(accountIndex: number, apiKeyIndex: number): Promise<number> {
        const res = await this.getJson<LighterNextNonceResponse>(
            "getNextNonce",
            LighterConstant.ENDPOINTS.nextNonce,
            { account_index: accountIndex, api_key_index: apiKeyIndex },
        );
        return res.nonce;
    }

    // ==================== WRITE PATH (signer) ====================

    /**
     * Integrator (builder) fee params for the signer. Only attached when the caller opts in
     * (`applyIntegratorFee`) AND an integrator is configured on this client.
     */
    private integratorInput(applyIntegratorFee?: boolean): {
        integratorAccountIndex?: number;
        integratorTakerFee?: number;
        integratorMakerFee?: number;
    } {
        if (!applyIntegratorFee || !this.integrator) return {};
        return {
            integratorAccountIndex: this.integrator.accountIndex,
            integratorTakerFee: this.integrator.takerFee,
            integratorMakerFee: this.integrator.makerFee,
        };
    }

    public async createMarketOrder(
        ctx: LighterSignerContext,
        params: LighterCreateMarketOrderParams,
    ): Promise<LighterSendTxResponse> {
        // A Lighter market order is an IOC limit that fills up to a worst-case price bound. price 0 means a
        // buy can never fill (limit 0) and a sell has NO slippage protection — so a bound is required.
        const price = params.price !== undefined ? Number(params.price) : 0;
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(
                "LighterRestClient::createMarketOrder::a positive worst-case price bound is required (integer scaled by price_decimals); use the high-level client's slippage, or pass params.price",
            );
        }
        return this.nonces.withNonce(ctx.accountIndex, ctx.apiKeyIndex, async (nonce) => {
            const signed = await signCreateOrder(this.clientContext(ctx), {
                marketIndex: params.marketIndex,
                clientOrderIndex: params.clientOrderIndex,
                baseAmount: params.baseAmount,
                price,
                isAsk: params.isAsk,
                orderType: LighterConstant.ORDER_TYPE.MARKET,
                timeInForce: LighterConstant.TIME_IN_FORCE.IMMEDIATE_OR_CANCEL,
                reduceOnly: params.reduceOnly,
                orderExpiry: 0, // IOC/market orders require NilOrderExpiry (0)
                ...this.integratorInput(params.applyIntegratorFee),
                nonce,
            });
            return this.sendTx("createMarketOrder", signed.txType, signed.txInfo);
        });
    }

    /**
     * Place a resting LIMIT order. `timeInForce`/`postOnly` map to Lighter's TIF:
     * ioc -> IMMEDIATE_OR_CANCEL (expiry 0), alo/postOnly -> POST_ONLY, gtc (default) -> GOOD_TILL_TIME.
     * GTT orders require a non-nil expiry; -1 lets the signer set 28 days (Lighter's max resting life).
     */
    public async createLimitOrder(
        ctx: LighterSignerContext,
        params: LighterCreateLimitOrderParams,
    ): Promise<LighterSendTxResponse> {
        const isIoc = params.timeInForce === "ioc";
        const isPostOnly = params.postOnly === true || params.timeInForce === "alo";
        const timeInForce = isIoc
            ? LighterConstant.TIME_IN_FORCE.IMMEDIATE_OR_CANCEL
            : isPostOnly
                ? LighterConstant.TIME_IN_FORCE.POST_ONLY
                : LighterConstant.TIME_IN_FORCE.GOOD_TILL_TIME;
        return this.nonces.withNonce(ctx.accountIndex, ctx.apiKeyIndex, async (nonce) => {
            const signed = await signCreateOrder(this.clientContext(ctx), {
                marketIndex: params.marketIndex,
                clientOrderIndex: params.clientOrderIndex,
                baseAmount: params.baseAmount,
                price: Number(params.price),
                isAsk: params.isAsk,
                orderType: LighterConstant.ORDER_TYPE.LIMIT,
                timeInForce,
                reduceOnly: Boolean(params.reduceOnly),
                orderExpiry: isIoc ? 0 : -1, // IOC uses NilOrderExpiry; resting orders get the signer's 28d max
                ...this.integratorInput(params.applyIntegratorFee),
                nonce,
            });
            return this.sendTx("createLimitOrder", signed.txType, signed.txInfo);
        });
    }

    /**
     * Place a reduce-only TAKE_PROFIT or STOP_LOSS trigger order (native TP/SL for a single-leg position).
     * Lighter requires: perps market, IOC, a non-nil trigger price and a non-nil expiry (we pass -1 → 28d),
     * and price >= 1 (worst-case execution bound).
     */
    public async createTriggerOrder(
        ctx: LighterSignerContext,
        params: {
            marketIndex: number;
            baseAmount: bigint | number;
            isAsk: boolean;
            /** ORDER_TYPE.TAKE_PROFIT or ORDER_TYPE.STOP_LOSS. */
            orderType: number;
            /** Trigger price, integer scaled by price_decimals (uint32). */
            triggerPrice: number;
            /** Worst-case execution price bound, integer scaled by price_decimals (uint32, >= 1). */
            price: number;
            clientOrderIndex: number;
            /** Attach the configured integrator (builder) fee — only for accounts that have approved. */
            applyIntegratorFee?: boolean;
        },
    ): Promise<LighterSendTxResponse> {
        return this.nonces.withNonce(ctx.accountIndex, ctx.apiKeyIndex, async (nonce) => {
            const signed = await signCreateOrder(this.clientContext(ctx), {
                marketIndex: params.marketIndex,
                clientOrderIndex: params.clientOrderIndex,
                baseAmount: params.baseAmount,
                price: params.price,
                isAsk: params.isAsk,
                orderType: params.orderType,
                timeInForce: LighterConstant.TIME_IN_FORCE.IMMEDIATE_OR_CANCEL,
                reduceOnly: true,
                triggerPrice: params.triggerPrice,
                orderExpiry: -1, // trigger orders require a non-nil expiry; -1 → signer sets 28 days (max)
                ...this.integratorInput(params.applyIntegratorFee),
                nonce,
            });
            return this.sendTx("createTriggerOrder", signed.txType, signed.txInfo);
        });
    }

    /** Set per-market leverage. `leverage` is converted to Lighter's margin fraction (clamped by min). */
    public async updateLeverage(
        ctx: LighterSignerContext,
        params: { marketIndex: number; leverage: number; marginMode?: number; minFraction?: number },
    ): Promise<LighterSendTxResponse> {
        const fraction = LighterHelper.leverageToMarginFraction(params.leverage, params.minFraction);
        return this.nonces.withNonce(ctx.accountIndex, ctx.apiKeyIndex, async (nonce) => {
            const signed = await signUpdateLeverage(this.clientContext(ctx), {
                marketIndex: params.marketIndex,
                fraction,
                marginMode: params.marginMode ?? LighterConstant.MARGIN_MODE.CROSS,
                nonce,
            });
            return this.sendTx("updateLeverage", signed.txType, signed.txInfo);
        });
    }

    public async cancelOrder(
        ctx: LighterSignerContext,
        params: { marketIndex: number; orderIndex: number },
    ): Promise<LighterSendTxResponse> {
        return this.nonces.withNonce(ctx.accountIndex, ctx.apiKeyIndex, async (nonce) => {
            const signed = await signCancelOrder(this.clientContext(ctx), {
                marketIndex: params.marketIndex,
                orderIndex: params.orderIndex,
                nonce,
            });
            return this.sendTx("cancelOrder", signed.txType, signed.txInfo);
        });
    }

    /**
     * Atomically cancel every resting order (marketIndex 255 = all markets, the default) or all orders in a
     * single market, in ONE tx (tx_type 16). Preferred over cancelling order-by-order — one nonce, one round
     * trip, no window for fills between per-order cancels.
     */
    public async cancelAllOrders(
        ctx: LighterSignerContext,
        params: { marketIndex?: number; timeInForce?: number; time?: number } = {},
    ): Promise<LighterSendTxResponse> {
        return this.nonces.withNonce(ctx.accountIndex, ctx.apiKeyIndex, async (nonce) => {
            const signed = await signCancelAllOrders(this.clientContext(ctx), {
                marketIndex: params.marketIndex ?? LighterConstant.CANCEL_ALL_MARKETS,
                timeInForce: params.timeInForce,
                time: params.time,
                nonce,
            });
            return this.sendTx("cancelAllOrders", signed.txType, signed.txInfo);
        });
    }

    /** Modify a resting order's size/price/trigger. */
    public async modifyOrder(
        ctx: LighterSignerContext,
        params: { marketIndex: number; orderIndex: number; baseAmount: bigint | number; price: number; triggerPrice?: number },
    ): Promise<LighterSendTxResponse> {
        return this.nonces.withNonce(ctx.accountIndex, ctx.apiKeyIndex, async (nonce) => {
            const signed = await signModifyOrder(this.clientContext(ctx), {
                marketIndex: params.marketIndex,
                orderIndex: params.orderIndex,
                baseAmount: params.baseAmount,
                price: params.price,
                triggerPrice: params.triggerPrice,
                nonce,
            });
            return this.sendTx("modifyOrder", signed.txType, signed.txInfo);
        });
    }

    /**
     * Submit a fully-signed ChangePubKey tx (tx_type 8) whose txInfo already has both the L2 self-signature
     * and the merged-in L1 signature. Used to bind a new API key on-chain.
     */
    public async sendChangePubKey(txType: number, txInfo: string): Promise<LighterSendTxResponse> {
        return this.sendTx("sendChangePubKey", txType, txInfo);
    }

    /**
     * L2-sign an ApproveIntegrator (tx_type 45) authorising this client's configured integrator account to
     * charge up to its fee on the account's orders, until now+TTL (ms). The returned `txInfo` has an empty
     * `L1Sig`; the account owner's wallet personal_signs `messageToSign` and that signature is spliced into
     * `L1Sig` before `sendApproveIntegrator`. `nonce` is returned so the caller can persist it (the signed
     * nonce is part of the L1 message, so it cannot be changed after the user signs).
     */
    public async buildApproveIntegrator(
        ctx: LighterSignerContext,
        approvalExpiryMs: number,
    ): Promise<{ txType: number; txInfo: string; messageToSign: string; nonce: number; integratorAccountIndex: number }> {
        if (!this.integrator) {
            throw new Error("Lighter integrator is not configured for this client");
        }
        const nonce = await this.getNextNonce(ctx.accountIndex, ctx.apiKeyIndex);
        const signed = await signApproveIntegrator(this.clientContext(ctx), {
            integratorAccountIndex: this.integrator.accountIndex,
            maxPerpsTakerFee: this.integrator.takerFee,
            maxPerpsMakerFee: this.integrator.makerFee,
            maxSpotTakerFee: 0,
            maxSpotMakerFee: 0,
            approvalExpiryMs,
            nonce,
        });
        return { txType: signed.txType, txInfo: signed.txInfo, messageToSign: signed.messageToSign, nonce, integratorAccountIndex: this.integrator.accountIndex };
    }

    /** Submit the ApproveIntegrator tx (L1Sig already merged in) to /sendTx. */
    public async sendApproveIntegrator(txType: number, txInfo: string): Promise<LighterSendTxResponse> {
        return this.sendTx("sendApproveIntegrator", txType, txInfo);
    }

    private async sendTx(methodName: string, txType: number, txInfo: string): Promise<LighterSendTxResponse> {
        const url = LighterHelper.buildUrl(this.baseUrl, LighterConstant.ENDPOINTS.sendTx);
        const form = new URLSearchParams();
        form.append("tx_type", String(txType));
        form.append("tx_info", txInfo);
        Logger.debug(`LighterRestClient::sendTx::method=${methodName}, txType=${txType}`);
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: form.toString(),
        });
        const rawText = await response.text();
        let parsed: LighterSendTxResponse | null = null;
        if (rawText) {
            try {
                parsed = JSON.parse(rawText) as LighterSendTxResponse;
            } catch {
                throw new Error(`LighterRestClient::${methodName}::non-JSON response: ${rawText}`);
            }
        }
        if (!response.ok || !parsed || (parsed.code !== undefined && parsed.code !== 200)) {
            const message = parsed?.message || rawText || `Lighter sendTx failed with status ${response.status}`;
            Logger.error(`LighterRestClient::${methodName}::${message}`);
            throw new Error(String(message));
        }
        return parsed;
    }

    private async getJsonAuthed<T extends { code?: number; message?: string }>(
        methodName: string,
        endpoint: string,
        token: string,
        query?: Record<string, unknown>,
    ): Promise<T> {
        return this.getJson<T>(methodName, endpoint, query, { Authorization: token });
    }

    private async getJson<T extends { code?: number; message?: string }>(
        methodName: string,
        endpoint: string,
        query?: Record<string, unknown>,
        headers?: Record<string, string>,
    ): Promise<T> {
        const url = LighterHelper.buildUrl(this.baseUrl, endpoint, query);
        Logger.debug(`LighterRestClient::request::url=${url}`);
        const response = await fetch(url, { method: "GET", headers: { Accept: "application/json", ...(headers || {}) } });
        const rawText = await response.text();
        let parsed: T | null = null;
        if (rawText) {
            try {
                parsed = JSON.parse(rawText) as T;
            } catch {
                throw new Error(`LighterRestClient::${methodName}::non-JSON response: ${rawText}`);
            }
        }
        if (!response.ok || !parsed || (parsed.code !== undefined && parsed.code !== 200)) {
            const message = parsed?.message || rawText || `Lighter request failed with status ${response.status}`;
            Logger.error(`LighterRestClient::${methodName}::${message}`);
            throw new Error(String(message));
        }
        return parsed;
    }
}
