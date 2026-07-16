import { describe, it, expect, vi, beforeEach } from "vitest";
import LighterClient from "../src/client";

function makeFakeRest() {
    return {
        getOrderBookDetails: vi.fn(async () => [
            { market_id: 1, symbol: "BTC", price_decimals: 2, size_decimals: 5, min_base_amount: "0.0001", min_quote_amount: "1", min_initial_margin_fraction: 500, last_trade_price: 60000 },
            { market_id: 2, symbol: "ETH", price_decimals: 3, size_decimals: 4, min_base_amount: "0.001", min_quote_amount: "1", min_initial_margin_fraction: 1000, last_trade_price: 3000 },
        ]),
        createMarketOrder: vi.fn(async () => ({ code: 200, tx_hash: "0xm" })),
        createLimitOrder: vi.fn(async () => ({ code: 200, tx_hash: "0xl" })),
        cancelAllOrders: vi.fn(async () => ({ code: 200, tx_hash: "0xca" })),
        updateLeverage: vi.fn(async () => ({ code: 200 })),
        cancelOrder: vi.fn(async () => ({ code: 200 })),
        getActiveOrders: vi.fn(async () => [{ order_index: 5, market_index: 1 }]),
        getAccount: vi.fn(async () => ({ account_index: 7, positions: [] })),
        getPositions: vi.fn(async () => []),
    };
}

const SIGNER = { apiPrivateKey: "k", accountIndex: 7, apiKeyIndex: 4 };
let rest: ReturnType<typeof makeFakeRest>;

beforeEach(() => {
    rest = makeFakeRest();
});

function client(withSigner = true) {
    return new LighterClient({ restClient: rest as any, signer: withSigner ? SIGNER : undefined });
}

describe("LighterClient markets", () => {
    it("loads + resolves markets by symbol and computes max leverage", async () => {
        const c = client();
        await c.loadMarkets();
        expect(c.market("btc").marketId).toBe(1); // case-insensitive
        expect(c.market("BTC").maxLeverage).toBe(20); // 10000 / 500
        expect(c.market("ETH").maxLeverage).toBe(10); // 10000 / 1000
        await c.markets();
        expect(rest.getOrderBookDetails).toHaveBeenCalledTimes(1); // cached
    });

    it("throws on an unknown symbol", async () => {
        const c = client();
        await c.loadMarkets();
        expect(() => c.market("DOGE")).toThrow(/unknown symbol/);
    });

    it("market() before load throws", () => {
        expect(() => client().market("BTC")).toThrow(/markets not loaded/);
    });
});

describe("LighterClient order placement scaling", () => {
    it("placeMarketOrder long scales size, maps is_ask=false, and ALWAYS sets a price bound (default slippage)", async () => {
        const c = client();
        await c.placeMarketOrder({ symbol: "BTC", side: "long", size: "0.5" });
        const arg = rest.createMarketOrder.mock.calls[0][1];
        expect(arg.marketIndex).toBe(1);
        expect(arg.baseAmount).toBe(50000n); // 0.5 * 10^5
        expect(arg.isAsk).toBe(false);
        expect(arg.reduceOnly).toBe(false);
        // default 5% slippage: 60000 * 1.05 = 63000 -> * 10^2 = 6300000 (never 0/undefined)
        expect(arg.price).toBe(6300000);
    });

    it("placeMarketOrder short with explicit slippage sets a tighter worst-case bound + is_ask=true", async () => {
        const c = client();
        await c.placeMarketOrder({ symbol: "BTC", side: "short", size: 1, slippage: 0.01 });
        const arg = rest.createMarketOrder.mock.calls[0][1];
        expect(arg.isAsk).toBe(true);
        expect(arg.price).toBe(5940000); // 60000 * 0.99 * 100
    });

    it("placeLimitOrder scales price with the market's price_decimals", async () => {
        const c = client();
        await c.placeLimitOrder({ symbol: "ETH", side: "long", size: "2", price: "3050.5", timeInForce: "gtc" });
        const arg = rest.createLimitOrder.mock.calls[0][1];
        expect(arg.marketIndex).toBe(2);
        expect(arg.baseAmount).toBe(20000n); // 2 * 10^4
        expect(arg.price).toBe(3050500); // 3050.5 * 10^3
        expect(arg.isAsk).toBe(false);
        expect(arg.timeInForce).toBe("gtc");
    });

    it("generates a unique clientOrderIndex per order", async () => {
        const c = client();
        await c.placeLimitOrder({ symbol: "BTC", side: "long", size: "1", price: "60000" });
        await c.placeLimitOrder({ symbol: "BTC", side: "long", size: "1", price: "60000" });
        const a = rest.createLimitOrder.mock.calls[0][1].clientOrderIndex;
        const b = rest.createLimitOrder.mock.calls[1][1].clientOrderIndex;
        expect(a).not.toBe(b);
        expect(a).toBeLessThanOrEqual(281474976710655); // uint48
    });

    it("honours an explicit clientOrderIndex", async () => {
        const c = client();
        await c.placeLimitOrder({ symbol: "BTC", side: "long", size: "1", price: "60000", clientOrderIndex: 777 });
        expect(rest.createLimitOrder.mock.calls[0][1].clientOrderIndex).toBe(777);
    });
});

describe("LighterClient min-size validation", () => {
    it("rejects a limit order below the market minimum base size before submitting", async () => {
        const c = client();
        await c.loadMarkets();
        await expect(
            c.placeLimitOrder({ symbol: "BTC", side: "long", size: "0.00001", price: "60000" }), // < 0.0001 min
        ).rejects.toThrow(/below BTC minimum/);
        expect(rest.createLimitOrder).not.toHaveBeenCalled();
    });

    it("rejects an order whose notional is below the market minimum quote", async () => {
        const c = client();
        await c.loadMarkets();
        // size 0.001 BTC * price 0.5 = 0.0005 notional < min_quote 1 (and price 0.5 well above min base)
        await expect(
            c.placeLimitOrder({ symbol: "BTC", side: "long", size: "0.001", price: "0.5" }),
        ).rejects.toThrow(/below BTC minimum/);
    });
});

describe("LighterClient leverage + cancel", () => {
    it("setLeverage passes the market min fraction as the clamp", async () => {
        const c = client();
        await c.setLeverage({ symbol: "BTC", leverage: 50 });
        const arg = rest.updateLeverage.mock.calls[0][1];
        expect(arg.marketIndex).toBe(1);
        expect(arg.leverage).toBe(50);
        expect(arg.minFraction).toBe(500);
    });

    it("cancelAllOrders uses the atomic single-tx path (all markets = 255)", async () => {
        const c = client();
        const res = await c.cancelAllOrders();
        expect(rest.cancelAllOrders).toHaveBeenCalledTimes(1);
        expect(rest.cancelAllOrders.mock.calls[0][1]).toEqual({ marketIndex: 255 });
        expect(res.tx_hash).toBe("0xca");
        expect(rest.cancelOrder).not.toHaveBeenCalled(); // not the per-order loop
    });

    it("cancelAllOrders scoped to a symbol targets that market index", async () => {
        const c = client();
        await c.cancelAllOrders(undefined, "ETH");
        expect(rest.cancelAllOrders.mock.calls[0][1]).toEqual({ marketIndex: 2 });
    });
});

describe("LighterClient signer guards", () => {
    it("throws when no signer is available", async () => {
        const c = client(false);
        await expect(c.placeMarketOrder({ symbol: "BTC", side: "long", size: "1" })).rejects.toThrow(/signer context is required/);
    });

    it("uses a per-call ctx over the default signer", async () => {
        const c = client(false);
        await c.loadMarkets();
        await c.placeMarketOrder({ symbol: "BTC", side: "long", size: "1" }, { apiPrivateKey: "x", accountIndex: 9, apiKeyIndex: 4 });
        expect(rest.createMarketOrder.mock.calls[0][0]).toEqual({ apiPrivateKey: "x", accountIndex: 9, apiKeyIndex: 4 });
    });

    it("getPositions falls back to the default signer's accountIndex", async () => {
        const c = client();
        await c.getPositions();
        expect(rest.getPositions).toHaveBeenCalledWith(7);
    });
});
