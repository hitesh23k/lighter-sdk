import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the WASM signer so REST tests stay pure (no WASM load, no network). We assert the client wires
// the right inputs into the signer and the right tx into /sendTx.
// Mocks return a static txInfo string (the real signer returns a JSON string too). The order/leverage
// inputs — including bigint baseAmount — are captured via mock.calls, not serialized here. The client
// imports the pure sign functions from ../src/signer/core, so that is the module we mock.
vi.mock("../src/signer/core", () => ({
    signCreateOrder: vi.fn(async () => ({ txType: 14, txInfo: "{}" })),
    signCancelOrder: vi.fn(async () => ({ txType: 15, txInfo: "{}" })),
    signModifyOrder: vi.fn(async () => ({ txType: 17, txInfo: "{}" })),
    signUpdateLeverage: vi.fn(async () => ({ txType: 20, txInfo: "{}" })),
    signApproveIntegrator: vi.fn(async () => ({ txType: 45, txInfo: "{}", messageToSign: "L1-message" })),
    createAuthToken: vi.fn(async () => "auth-token-abc"),
}));

import LighterRestClient from "../src/rest/client";
import LighterConstant from "../src/constants";
import { signCreateOrder, signUpdateLeverage, createAuthToken } from "../src/signer/core";

type FetchCall = { url: string; init?: any };
let calls: FetchCall[];

/** Install a fetch that routes by URL substring to a JSON body (status 200 unless overridden). */
function mockFetch(routes: Array<{ match: string; body: any; status?: number; text?: string }>) {
    calls = [];
    const fn = vi.fn(async (url: string, init?: any) => {
        calls.push({ url: String(url), init });
        const route = routes.find((r) => String(url).includes(r.match));
        if (!route) throw new Error(`no mock route for ${url}`);
        const status = route.status ?? 200;
        const text = route.text !== undefined ? route.text : JSON.stringify(route.body);
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
        } as any;
    });
    vi.stubGlobal("fetch", fn);
    return fn;
}

const SIGNER = { apiPrivateKey: "0xkey", accountIndex: 7, apiKeyIndex: 4 };

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("LighterRestClient venue resolution", () => {
    it("defaults to zk mainnet host + chainId", () => {
        const c = new LighterRestClient();
        expect((c as any).baseUrl).toBe(LighterConstant.VENUE_CONFIG.zk.mainnetBaseUrl);
        expect((c as any).chainId).toBe(304);
        expect((c as any).isMainnet).toBe(true);
    });

    it("resolves robinhood mainnet chainId 466324", () => {
        const c = new LighterRestClient({ venue: "robinhood" });
        expect((c as any).baseUrl).toBe(LighterConstant.VENUE_CONFIG.robinhood.mainnetBaseUrl);
        expect((c as any).chainId).toBe(466324);
    });

    it("resolves testnet when isMainnet:false", () => {
        const c = new LighterRestClient({ venue: "zk", isMainnet: false });
        expect((c as any).baseUrl).toBe(LighterConstant.VENUE_CONFIG.zk.testnetBaseUrl);
        expect((c as any).chainId).toBe(300);
    });

    it("throws on an unknown venue", () => {
        expect(() => new LighterRestClient({ venue: "nope" })).toThrow(/Unknown Lighter venue/);
    });
});

describe("LighterRestClient reads", () => {
    it("parses orderBookDetails and hits the right endpoint", async () => {
        mockFetch([{ match: "/orderBookDetails", body: { code: 200, order_book_details: [{ market_id: 1, symbol: "BTC" }] } }]);
        const c = new LighterRestClient();
        const details = await c.getOrderBookDetails();
        expect(details).toHaveLength(1);
        expect(details[0].symbol).toBe("BTC");
        expect(calls[0].url).toContain("mainnet.zklighter.elliot.ai/api/v1/orderBookDetails");
        expect(calls[0].init.method).toBe("GET");
    });

    it("getAccount falls back from account to accounts[0]", async () => {
        mockFetch([{ match: "/account", body: { code: 200, accounts: [{ account_index: 7 }] } }]);
        const c = new LighterRestClient();
        const acct = await c.getAccount(7);
        expect(acct?.account_index).toBe(7);
        expect(calls[0].url).toContain("by=index&value=7");
    });

    it("getAccountsByL1Address prefers sub_accounts", async () => {
        mockFetch([{ match: "/accountsByL1Address", body: { code: 200, sub_accounts: [{ account_index: 9 }] } }]);
        const c = new LighterRestClient();
        const accts = await c.getAccountsByL1Address("0xABC");
        expect(accts[0].account_index).toBe(9);
        expect(calls[0].url).toContain("l1_address=0xABC");
    });

    it("throws on a non-200 code with the server message", async () => {
        mockFetch([{ match: "/tokenlist", body: { code: 400, message: "bad thing" } }]);
        const c = new LighterRestClient();
        await expect(c.getTokenList()).rejects.toThrow("bad thing");
    });

    it("throws on a non-JSON body", async () => {
        mockFetch([{ match: "/funding-rates", body: null, text: "<html>502</html>" }]);
        const c = new LighterRestClient();
        await expect(c.getFundingRates()).rejects.toThrow(/non-JSON response/);
    });
});

describe("LighterRestClient authed reads", () => {
    it("attaches the Authorization header and caches the auth token across calls", async () => {
        mockFetch([
            { match: "/accountActiveOrders", body: { code: 200, orders: [] } },
            { match: "/trades", body: { code: 200, trades: [] } },
        ]);
        const c = new LighterRestClient();
        await c.getActiveOrders(SIGNER);
        await c.getAccountTrades(SIGNER);
        // token minted once, reused for the second authed read
        expect((createAuthToken as any).mock.calls.length).toBe(1);
        const authedCall = calls.find((x) => x.url.includes("/accountActiveOrders"));
        expect(authedCall?.init.headers.Authorization).toBe("auth-token-abc");
    });
});

describe("LighterRestClient write path", () => {
    it("createLimitOrder fetches nonce, signs, and posts tx to /sendTx", async () => {
        mockFetch([
            { match: "/nextNonce", body: { nonce: 42 } },
            { match: "/sendTx", body: { code: 200, tx_hash: "0xhash" } },
        ]);
        const c = new LighterRestClient();
        const res = await c.createLimitOrder(SIGNER, {
            marketIndex: 1,
            baseAmount: 100n,
            price: 500000,
            isAsk: false,
            clientOrderIndex: 123,
        });
        expect(res.tx_hash).toBe("0xhash");
        // signer received the resolved nonce and GTT expiry (-1) with LIMIT/GTT codes.
        const input = (signCreateOrder as any).mock.calls[0][1];
        expect(input.nonce).toBe(42);
        expect(input.orderType).toBe(LighterConstant.ORDER_TYPE.LIMIT);
        expect(input.timeInForce).toBe(LighterConstant.TIME_IN_FORCE.GOOD_TILL_TIME);
        expect(input.orderExpiry).toBe(-1);
        // no integrator configured => no fee fields
        expect(input.integratorAccountIndex).toBeUndefined();
        // POST body carries tx_type + tx_info
        const post = calls.find((x) => x.url.includes("/sendTx"));
        expect(post?.init.method).toBe("POST");
        expect(post?.init.body).toContain("tx_type=14");
        expect(post?.init.body).toContain("tx_info=");
    });

    it("IOC limit uses NilOrderExpiry (0) and IOC tif", async () => {
        mockFetch([
            { match: "/nextNonce", body: { nonce: 1 } },
            { match: "/sendTx", body: { code: 200 } },
        ]);
        const c = new LighterRestClient();
        await c.createLimitOrder(SIGNER, { marketIndex: 1, baseAmount: 10n, price: 5, isAsk: true, clientOrderIndex: 1, timeInForce: "ioc" });
        const input = (signCreateOrder as any).mock.calls[0][1];
        expect(input.timeInForce).toBe(LighterConstant.TIME_IN_FORCE.IMMEDIATE_OR_CANCEL);
        expect(input.orderExpiry).toBe(0);
    });

    it("attaches the integrator fee only when configured AND applyIntegratorFee", async () => {
        mockFetch([
            { match: "/nextNonce", body: { nonce: 1 } },
            { match: "/sendTx", body: { code: 200 } },
        ]);
        const c = new LighterRestClient({ integrator: { accountIndex: 733818, takerFee: 500, makerFee: 500 } });
        await c.createLimitOrder(SIGNER, { marketIndex: 1, baseAmount: 10n, price: 5, isAsk: false, clientOrderIndex: 1, applyIntegratorFee: true });
        const input = (signCreateOrder as any).mock.calls[0][1];
        expect(input.integratorAccountIndex).toBe(733818);
        expect(input.integratorTakerFee).toBe(500);
        expect(input.integratorMakerFee).toBe(500);
    });

    it("omits the integrator fee when applyIntegratorFee is not set", async () => {
        mockFetch([
            { match: "/nextNonce", body: { nonce: 1 } },
            { match: "/sendTx", body: { code: 200 } },
        ]);
        const c = new LighterRestClient({ integrator: { accountIndex: 733818, takerFee: 500, makerFee: 500 } });
        await c.createLimitOrder(SIGNER, { marketIndex: 1, baseAmount: 10n, price: 5, isAsk: false, clientOrderIndex: 1 });
        const input = (signCreateOrder as any).mock.calls[0][1];
        expect(input.integratorAccountIndex).toBeUndefined();
    });

    it("updateLeverage converts leverage to a clamped margin fraction", async () => {
        mockFetch([
            { match: "/nextNonce", body: { nonce: 3 } },
            { match: "/sendTx", body: { code: 200 } },
        ]);
        const c = new LighterRestClient();
        await c.updateLeverage(SIGNER, { marketIndex: 2, leverage: 20 });
        const input = (signUpdateLeverage as any).mock.calls[0][1];
        expect(input.fraction).toBe(500); // 10000 / 20
        expect(input.marginMode).toBe(LighterConstant.MARGIN_MODE.CROSS);
    });

    it("sendTx surfaces a non-200 code as an error", async () => {
        mockFetch([
            { match: "/nextNonce", body: { nonce: 1 } },
            { match: "/sendTx", body: { code: 422, message: "nonce too low" } },
        ]);
        const c = new LighterRestClient();
        await expect(
            c.cancelOrder(SIGNER, { marketIndex: 1, orderIndex: 5 }),
        ).rejects.toThrow("nonce too low");
    });
});

describe("LighterRestClient integrator gating", () => {
    it("buildApproveIntegrator throws without an integrator config", async () => {
        const c = new LighterRestClient();
        await expect(c.buildApproveIntegrator(SIGNER, Date.now() + 1000)).rejects.toThrow(/integrator is not configured/);
    });

    it("probeIntegratorApproved throws without an integrator config", async () => {
        const c = new LighterRestClient();
        await expect(c.probeIntegratorApproved(SIGNER)).rejects.toThrow(/integrator is not configured/);
    });

    it("buildApproveIntegrator returns the signed tx + L1 message when configured", async () => {
        mockFetch([{ match: "/nextNonce", body: { nonce: 8 } }]);
        const c = new LighterRestClient({ integrator: { accountIndex: 733818, takerFee: 500, makerFee: 500 } });
        const out = await c.buildApproveIntegrator(SIGNER, 1893456000000);
        expect(out.txType).toBe(45);
        expect(out.messageToSign).toBe("L1-message");
        expect(out.nonce).toBe(8);
        expect(out.integratorAccountIndex).toBe(733818);
    });
});
