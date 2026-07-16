import { describe, it, expect, vi, beforeEach } from "vitest";
import LighterClient from "../src/client";

function makeFakeRest() {
    return {
        getOrderBookDetails: vi.fn(async () => [
            { market_id: 1, symbol: "BTC", price_decimals: 2, size_decimals: 5, min_base_amount: "10", min_quote_amount: "10", min_initial_margin_fraction: 500, last_trade_price: 60000 },
            { market_id: 2, symbol: "ETH", price_decimals: 3, size_decimals: 4, min_base_amount: "100", min_quote_amount: "10", min_initial_margin_fraction: 1000, last_trade_price: 3000 },
        ]),
        createMarketOrder: vi.fn(async () => ({ code: 200, tx_hash: "0xm" })),
        createLimitOrder: vi.fn(async () => ({ code: 200, tx_hash: "0xl" })),
        updateLeverage: vi.fn(async () => ({ code: 200 })),
        cancelOrder: vi.fn(async () => ({ code: 200 })),
        getActiveOrders: vi.fn(async () => [
            { order_index: 5, market_index: 1 },
            { order_index: 6, market_id: 2 },
        ]),
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
        // cached: second call doesn't refetch
        await c.markets();
        expect(rest.getOrderBookDetails).toHaveBeenCalledTimes(1);
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
    it("placeMarketOrder long scales size and maps to is_ask=false", async () => {
        const c = client();
        await c.placeMarketOrder({ symbol: "BTC", side: "long", size: "0.5" });
        const arg = rest.createMarketOrder.mock.calls[0][1];
        expect(arg.marketIndex).toBe(1);
        expect(arg.baseAmount).toBe(50000n); // 0.5 * 10^5
        expect(arg.isAsk).toBe(false);
        expect(arg.reduceOnly).toBe(false);
        expect(arg.price).toBeUndefined(); // no slippage bound
    });

    it("placeMarketOrder short with slippage sets a worst-case price bound + is_ask=true", async () => {
        const c = client();
        await c.placeMarketOrder({ symbol: "BTC", side: "short", size: 1, slippage: 0.01 });
        const arg = rest.createMarketOrder.mock.calls[0][1];
        expect(arg.isAsk).toBe(true);
        // 60000 * (1 - 0.01) = 59400 -> * 10^2 = 5940000
        expect(arg.price).toBe(5940000);
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
    });

    it("honours an explicit clientOrderIndex", async () => {
        const c = client();
        await c.placeLimitOrder({ symbol: "BTC", side: "long", size: "1", price: "60000", clientOrderIndex: 777 });
        expect(rest.createLimitOrder.mock.calls[0][1].clientOrderIndex).toBe(777);
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

    it("cancelAllOrders cancels each active order", async () => {
        const c = client();
        const res = await c.cancelAllOrders();
        expect(rest.cancelOrder).toHaveBeenCalledTimes(2);
        expect(rest.cancelOrder.mock.calls[0][1]).toEqual({ marketIndex: 1, orderIndex: 5 });
        expect(rest.cancelOrder.mock.calls[1][1]).toEqual({ marketIndex: 2, orderIndex: 6 });
        expect(res).toHaveLength(2);
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
