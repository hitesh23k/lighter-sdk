import { Logger } from "./logger";
import LighterConstant from "./constants";
import LighterHelper from "./helpers";
import LighterRestClient from "./rest/client";
import LighterWs from "./ws/client";
import { createAuthToken } from "./signer/core";
import {
    LighterRestClientConfig,
    LighterSignerContext,
    LighterOrderBookDetail,
    LighterSendTxResponse,
    LighterPosition,
    LighterAccount,
    LighterActiveOrder,
} from "./types";
import type { LighterChannelHandler, Unsubscribe } from "./ws/types";

/** Long = buy (is_ask false); short = sell (is_ask true). */
export type OrderSide = "long" | "short";

/** Default market-order slippage bound (5%) when the caller doesn't specify one. */
const DEFAULT_MARKET_SLIPPAGE = 0.05;
/** Refresh cached market data (incl. last price for slippage bounds) if older than this before a market order. */
const DEFAULT_MARKET_STALENESS_MS = 15_000;

/** Uniform random in [0,1) preferring crypto entropy (collision-resistant client_order_index across processes). */
function randomUnit(): number {
    const c = (globalThis as any).crypto;
    if (c && typeof c.getRandomValues === "function") {
        const buf = new Uint32Array(1);
        c.getRandomValues(buf);
        return buf[0] / 0x100000000;
    }
    // eslint-disable-next-line no-restricted-properties
    return Math.random();
}

/** Resolved, cached per-market metadata used to scale human values to the API's integers. */
export interface LighterMarketMeta {
    marketId: number;
    symbol: string;
    priceDecimals: number;
    sizeDecimals: number;
    /** Minimum order size in human token units. */
    minBaseAmount: number;
    /** Minimum order notional in human quote units. */
    minQuoteAmount: number;
    /** Max leverage the market allows (= SCALE / min_initial_margin_fraction); 0 when the market omits it. */
    maxLeverage: number;
    minInitialMarginFraction: number;
    lastTradePrice: number;
}

export interface LighterClientConfig extends LighterRestClientConfig {
    /** Default signer context for write calls, so per-call ctx is optional. */
    signer?: LighterSignerContext;
    /** Default market-order slippage bound (fraction) when a call omits `slippage`. Default 0.05 (5%). */
    defaultSlippage?: number;
    /** Refresh market data before a market order if older than this (ms). Default 15000. */
    marketStalenessMs?: number;
    /** Provider for the WS account-channel auth token; wired into the internal WS client. */
    getAuthToken?: () => string | Promise<string>;
    /** Advanced/testing override for the underlying REST client. */
    restClient?: LighterRestClient;
    /** Advanced/testing override for the underlying WS client. */
    wsClient?: LighterWs;
}

export interface PlaceMarketOrderParams {
    symbol: string;
    side: OrderSide;
    /** Order size in human token units (scaled to size_decimals internally). */
    size: number | string;
    reduceOnly?: boolean;
    /** Optional slippage bound (fraction, e.g. 0.02 = 2%) applied to last price for a worst-case price. */
    slippage?: number;
    applyIntegratorFee?: boolean;
    clientOrderIndex?: number;
}

export interface PlaceLimitOrderParams {
    symbol: string;
    side: OrderSide;
    /** Size in human token units. */
    size: number | string;
    /** Limit price in human quote units (scaled to price_decimals internally). */
    price: number | string;
    timeInForce?: "gtc" | "ioc" | "alo";
    postOnly?: boolean;
    reduceOnly?: boolean;
    applyIntegratorFee?: boolean;
    clientOrderIndex?: number;
}

/**
 * High-level, venue-aware convenience client over {@link LighterRestClient} and {@link LighterWs}. It
 * resolves markets by symbol, scales human sizes/prices to Lighter's integer encoding using each market's
 * decimals, maps long/short to is_ask, and streams by symbol. It is pure sugar — every low-level path is
 * still reachable through `.rest` and `.ws`.
 */
export default class LighterClient {
    public readonly rest: LighterRestClient;
    private readonly venue: string;
    private readonly isMainnet: boolean;
    private readonly defaultSigner?: LighterSignerContext;
    private readonly defaultSlippage: number;
    private readonly marketStalenessMs: number;
    private readonly getAuthToken?: () => string | Promise<string>;
    private wsClient: LighterWs | null;
    private readonly wsInjected: boolean;

    private marketsBySymbol: Map<string, LighterMarketMeta> | null = null;
    private marketsById: Map<number, LighterMarketMeta> | null = null;
    private marketsLoadedAt = 0;
    private coiCounter = 0;

    constructor(config: LighterClientConfig = {}) {
        this.venue = config.venue || LighterConstant.VENUE.ZK;
        this.isMainnet = config.isMainnet !== false;
        this.defaultSigner = config.signer;
        this.defaultSlippage = config.defaultSlippage ?? DEFAULT_MARKET_SLIPPAGE;
        this.marketStalenessMs = config.marketStalenessMs ?? DEFAULT_MARKET_STALENESS_MS;
        this.getAuthToken = config.getAuthToken;
        this.rest =
            config.restClient ||
            new LighterRestClient({ venue: this.venue, isMainnet: this.isMainnet, baseUrl: config.baseUrl, integrator: config.integrator });
        this.wsClient = config.wsClient || null;
        this.wsInjected = !!config.wsClient;
    }

    // ==================== markets ====================

    /** Fetch + cache market metadata (idempotent unless `force`). Auto-called by symbol-based methods. */
    public async loadMarkets(force = false): Promise<void> {
        if (this.marketsBySymbol && !force) return;
        const details = await this.rest.getOrderBookDetails();
        const bySymbol = new Map<string, LighterMarketMeta>();
        const byId = new Map<number, LighterMarketMeta>();
        for (const d of details) {
            const meta = LighterClient.toMeta(d);
            if (!meta.symbol) continue;
            bySymbol.set(meta.symbol, meta);
            byId.set(meta.marketId, meta);
        }
        this.marketsBySymbol = bySymbol;
        this.marketsById = byId;
        this.marketsLoadedAt = Date.now();
        Logger.debug(`LighterClient::loadMarkets::${bySymbol.size} markets`);
    }

    /** Reload market data if the cache is older than `maxAgeMs` (keeps the market-order price bound fresh). */
    private async ensureFreshMarkets(maxAgeMs: number): Promise<void> {
        if (!this.marketsBySymbol || Date.now() - this.marketsLoadedAt > maxAgeMs) {
            await this.loadMarkets(true);
        }
    }

    private static toMeta(d: LighterOrderBookDetail): LighterMarketMeta {
        const minFraction = Number(d.min_initial_margin_fraction || 0);
        const maxLeverage = minFraction > 0 ? Math.floor(LighterConstant.MARGIN_FRACTION_SCALE / minFraction) : 0;
        return {
            marketId: d.market_id,
            symbol: String(d.symbol || "").toUpperCase(),
            priceDecimals: d.price_decimals,
            sizeDecimals: d.size_decimals,
            minBaseAmount: Number(d.min_base_amount || 0),
            minQuoteAmount: Number(d.min_quote_amount || 0),
            maxLeverage,
            minInitialMarginFraction: minFraction,
            lastTradePrice: Number(d.last_trade_price || 0),
        };
    }

    /** All cached markets (loads on first call). */
    public async markets(): Promise<LighterMarketMeta[]> {
        await this.loadMarkets();
        return [...(this.marketsBySymbol as Map<string, LighterMarketMeta>).values()];
    }

    /** Resolve a market by symbol from cache; throws if not loaded/unknown. Call `loadMarkets()` first. */
    public market(symbol: string): LighterMarketMeta {
        if (!this.marketsBySymbol) {
            throw new Error("LighterClient::market::markets not loaded — await loadMarkets() first");
        }
        const meta = this.marketsBySymbol.get(symbol.toUpperCase());
        if (!meta) throw new Error(`LighterClient::market::unknown symbol "${symbol}"`);
        return meta;
    }

    /** Market index for a symbol (loads markets if needed). */
    public async marketId(symbol: string): Promise<number> {
        await this.loadMarkets();
        return this.market(symbol).marketId;
    }

    // ==================== trading ====================

    private requireSigner(ctx?: LighterSignerContext): LighterSignerContext {
        const signer = ctx || this.defaultSigner;
        if (!signer) throw new Error("LighterClient::a signer context is required (pass one or set config.signer)");
        return signer;
    }

    private nextClientOrderIndex(explicit?: number): number {
        if (explicit !== undefined) return explicit;
        // uint48 client_order_index: 29 high bits of ms time + 19 low bits of (random + per-call counter).
        // Randomness makes it collision-resistant across instances/processes; the counter guarantees
        // uniqueness for bursts within a single millisecond in this instance.
        const timeBits = Date.now() % 0x2000_0000; // 2^29 (~6.2 day wrap)
        const low = (Math.floor(randomUnit() * 0x8_0000) + this.coiCounter++) % 0x8_0000; // 2^19
        return (timeBits * 0x8_0000 + low) % LighterConstant.MAX_CLIENT_ORDER_INDEX;
    }

    /** Reject an order that is below the market's minimum size or notional before it burns a nonce. */
    private assertOrderMinimums(meta: LighterMarketMeta, baseAmount: bigint, sizeHuman: number, priceHuman?: number): void {
        if (meta.minBaseAmount > 0) {
            const minBase = LighterHelper.toBaseAmount(meta.minBaseAmount, meta.sizeDecimals);
            if (baseAmount < minBase) {
                throw new Error(
                    `LighterClient::order size ${sizeHuman} below ${meta.symbol} minimum ${meta.minBaseAmount}`,
                );
            }
        }
        if (meta.minQuoteAmount > 0 && priceHuman && priceHuman > 0) {
            const notional = sizeHuman * priceHuman;
            if (notional < meta.minQuoteAmount) {
                throw new Error(
                    `LighterClient::order notional ${notional.toFixed(4)} below ${meta.symbol} minimum ${meta.minQuoteAmount}`,
                );
            }
        }
    }

    /**
     * Place a market order (size in tokens). A worst-case price bound is ALWAYS sent — from `slippage`,
     * else the client's `defaultSlippage` (5%) — computed off a freshly-refreshed last price, so a market
     * buy can fill and a sell is slippage-protected. Never signs an unbounded (price 0) order.
     */
    public async placeMarketOrder(params: PlaceMarketOrderParams, ctx?: LighterSignerContext): Promise<LighterSendTxResponse> {
        const signer = this.requireSigner(ctx);
        await this.ensureFreshMarkets(this.marketStalenessMs);
        const meta = this.market(params.symbol);
        const baseAmount = LighterHelper.toBaseAmount(params.size, meta.sizeDecimals);
        const isAsk = params.side === "short";
        if (!(meta.lastTradePrice > 0)) {
            throw new Error(
                `LighterClient::placeMarketOrder::no reference price for ${meta.symbol} — cannot set a worst-case bound; use placeLimitOrder with an explicit price`,
            );
        }
        const slippage = params.slippage ?? this.defaultSlippage;
        const worstHuman = isAsk ? meta.lastTradePrice * (1 - slippage) : meta.lastTradePrice * (1 + slippage);
        this.assertOrderMinimums(meta, baseAmount, Number(params.size), meta.lastTradePrice);
        const price = Number(LighterHelper.toPriceInt(worstHuman, meta.priceDecimals));
        return this.rest.createMarketOrder(signer, {
            marketIndex: meta.marketId,
            baseAmount,
            isAsk,
            reduceOnly: Boolean(params.reduceOnly),
            clientOrderIndex: this.nextClientOrderIndex(params.clientOrderIndex),
            price,
            applyIntegratorFee: params.applyIntegratorFee,
        });
    }

    /** Place a resting/IOC limit order (size in tokens, price in quote units). */
    public async placeLimitOrder(params: PlaceLimitOrderParams, ctx?: LighterSignerContext): Promise<LighterSendTxResponse> {
        const signer = this.requireSigner(ctx);
        await this.loadMarkets();
        const meta = this.market(params.symbol);
        const baseAmount = LighterHelper.toBaseAmount(params.size, meta.sizeDecimals);
        this.assertOrderMinimums(meta, baseAmount, Number(params.size), Number(params.price));
        return this.rest.createLimitOrder(signer, {
            marketIndex: meta.marketId,
            baseAmount,
            price: Number(LighterHelper.toPriceInt(params.price, meta.priceDecimals)),
            isAsk: params.side === "short",
            clientOrderIndex: this.nextClientOrderIndex(params.clientOrderIndex),
            timeInForce: params.timeInForce,
            postOnly: params.postOnly,
            reduceOnly: params.reduceOnly,
            applyIntegratorFee: params.applyIntegratorFee,
        });
    }

    /** Set per-market leverage (clamped to the market's max). */
    public async setLeverage(
        params: { symbol: string; leverage: number; marginMode?: number },
        ctx?: LighterSignerContext,
    ): Promise<LighterSendTxResponse> {
        const signer = this.requireSigner(ctx);
        await this.loadMarkets();
        const meta = this.market(params.symbol);
        return this.rest.updateLeverage(signer, {
            marketIndex: meta.marketId,
            leverage: params.leverage,
            marginMode: params.marginMode,
            minFraction: meta.minInitialMarginFraction,
        });
    }

    /** Cancel a specific resting order by its order_index. */
    public async cancelOrder(symbol: string, orderIndex: number, ctx?: LighterSignerContext): Promise<LighterSendTxResponse> {
        const signer = this.requireSigner(ctx);
        const marketIndex = await this.marketId(symbol);
        return this.rest.cancelOrder(signer, { marketIndex, orderIndex });
    }

    /**
     * Atomically cancel every resting order for the account (or all orders in one symbol) in a single tx.
     * One nonce, one round trip, no window for fills between cancels — unlike a per-order loop.
     */
    public async cancelAllOrders(ctx?: LighterSignerContext, symbol?: string): Promise<LighterSendTxResponse> {
        const signer = this.requireSigner(ctx);
        const marketIndex = symbol ? await this.marketId(symbol) : LighterConstant.CANCEL_ALL_MARKETS;
        return this.rest.cancelAllOrders(signer, { marketIndex });
    }

    // ==================== reads ====================

    public async getAccount(accountIndex?: number): Promise<LighterAccount | null> {
        const idx = accountIndex ?? this.defaultSigner?.accountIndex;
        if (idx === undefined) throw new Error("LighterClient::getAccount::accountIndex required");
        return this.rest.getAccount(idx);
    }

    public async getPositions(accountIndex?: number): Promise<LighterPosition[]> {
        const idx = accountIndex ?? this.defaultSigner?.accountIndex;
        if (idx === undefined) throw new Error("LighterClient::getPositions::accountIndex required");
        return this.rest.getPositions(idx);
    }

    public async getOpenOrders(symbol?: string, ctx?: LighterSignerContext): Promise<LighterActiveOrder[]> {
        const signer = this.requireSigner(ctx);
        const marketId = symbol ? await this.marketId(symbol) : undefined;
        return this.rest.getActiveOrders(signer, marketId !== undefined ? { marketId } : {});
    }

    // ==================== streaming ====================

    /**
     * WS account-channel auth provider: the explicit `getAuthToken` config, else one minted from the
     * default signer (so `streamAccount*` works out of the box when a signer is configured).
     */
    private resolveAuthProvider(): (() => string | Promise<string>) | undefined {
        if (this.getAuthToken) return this.getAuthToken;
        const s = this.defaultSigner;
        if (!s) return undefined;
        const { baseUrl, chainId } = LighterConstant.resolveVenue(this.venue, this.isMainnet);
        return () => createAuthToken({ url: baseUrl, chainId, apiPrivateKey: s.apiPrivateKey, accountIndex: s.accountIndex, apiKeyIndex: s.apiKeyIndex });
    }

    /** The underlying WebSocket client (lazily created for this venue/network). */
    public get ws(): LighterWs {
        if (!this.wsClient) {
            this.wsClient = new LighterWs({ venue: this.venue, isMainnet: this.isMainnet, getAuthToken: this.resolveAuthProvider() });
        }
        return this.wsClient;
    }

    /** Connect the WebSocket (loads markets too, so symbol-based streams resolve). */
    public async connect(): Promise<void> {
        await this.loadMarkets();
        await this.ws.connect();
    }

    /** Stream the order book for a symbol (markets must be loaded; call `connect()`/`loadMarkets()` first). */
    public streamOrderBook(symbol: string, handler: LighterChannelHandler): Unsubscribe {
        return this.ws.subscribeOrderBook(this.market(symbol).marketId, handler);
    }

    /** Stream public trades for a symbol. */
    public streamTrades(symbol: string, handler: LighterChannelHandler): Unsubscribe {
        return this.ws.subscribeTrades(this.market(symbol).marketId, handler);
    }

    /** Stream all account updates (balances, positions, orders). */
    public streamAccount(handler: LighterChannelHandler, accountIndex?: number): Unsubscribe {
        const idx = accountIndex ?? this.defaultSigner?.accountIndex;
        if (idx === undefined) throw new Error("LighterClient::streamAccount::accountIndex required");
        return this.ws.subscribeAccountAll(idx, handler);
    }

    /** Close the WebSocket if this client owns it. */
    public close(): void {
        if (this.wsClient && !this.wsInjected) this.wsClient.close();
    }
}
