import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    signCreateOrder,
    signCancelOrder,
    signCancelAllOrders,
    signModifyOrder,
    signUpdateLeverage,
    signApproveIntegrator,
    createAuthToken,
    generateApiKey,
    type LighterClientContext,
} from "../src/signer/signer";

const SIGNER_DIR = path.join(process.cwd(), "src/signer");
const artifactsPresent =
    fs.existsSync(path.join(SIGNER_DIR, "lighterSigner.wasm")) &&
    fs.existsSync(path.join(SIGNER_DIR, "wasm_exec.js"));

describe.runIf(artifactsPresent)("LighterSigner (WASM)", () => {
    // Mint an ephemeral key at runtime — never hardcode key material in the repo.
    let ctx: LighterClientContext;

    beforeAll(async () => {
        const kp = await generateApiKey();
        expect(kp.privateKey).toMatch(/^0x?[0-9a-fA-F]+$/);
        expect(kp.publicKey.length).toBeGreaterThan(0);
        ctx = {
            url: "https://testnet.zklighter.elliot.ai",
            chainId: 300,
            apiPrivateKey: kp.privateKey,
            accountIndex: 1,
            apiKeyIndex: 4,
        };
    });

    it("produces a signed create-order tx (txType 14) for a market IOC order", async () => {
        const signed = await signCreateOrder(ctx, {
            marketIndex: 1,
            clientOrderIndex: 12345,
            baseAmount: 20n,
            price: 617104,
            isAsk: false,
            orderType: 1, // MARKET
            timeInForce: 0, // IOC
            reduceOnly: false,
            orderExpiry: 0, // NilOrderExpiry required for IOC
            nonce: 0,
        });
        expect(signed.txType).toBe(14);
        const info = JSON.parse(signed.txInfo);
        expect(String(info.Sig).length).toBeGreaterThan(0);
        expect(info.MarketIndex).toBe(1);
        expect(info.IsAsk).toBe(0);
    });

    it("produces a signed cancel-order tx (txType 15)", async () => {
        const signed = await signCancelOrder(ctx, { marketIndex: 1, orderIndex: 999, nonce: 0 });
        expect(signed.txType).toBe(15);
        expect(JSON.parse(signed.txInfo).Sig).toBeTruthy();
    });

    it("produces a signed modify-order tx", async () => {
        const signed = await signModifyOrder(ctx, { marketIndex: 1, orderIndex: 999, baseAmount: 30n, price: 617104, nonce: 0 });
        expect(typeof signed.txType).toBe("number");
        expect(signed.txType).toBeGreaterThan(0);
        const info = JSON.parse(signed.txInfo);
        expect(info.Sig).toBeTruthy();
        expect(info.Index).toBe(999);
    });

    it("produces a signed update-leverage tx", async () => {
        const signed = await signUpdateLeverage(ctx, { marketIndex: 1, fraction: 500, marginMode: 0, nonce: 0 });
        expect(typeof signed.txType).toBe("number");
        expect(signed.txType).toBeGreaterThan(0);
        expect(JSON.parse(signed.txInfo).Sig).toBeTruthy();
    });

    it("produces an approve-integrator tx (txType 45) with an L1 message to sign", async () => {
        const signed = await signApproveIntegrator(ctx, {
            integratorAccountIndex: 733818,
            maxPerpsTakerFee: 500,
            maxPerpsMakerFee: 500,
            maxSpotTakerFee: 0,
            maxSpotMakerFee: 0,
            approvalExpiryMs: 1893456000000, // 2030-01-01, an absolute epoch-ms expiry
            nonce: 0,
        });
        expect(signed.txType).toBe(45);
        expect(signed.messageToSign.length).toBeGreaterThan(0);
        expect(JSON.parse(signed.txInfo)).toBeTruthy();
    });

    it("mints an auth token", async () => {
        const token = await createAuthToken(ctx);
        expect(typeof token).toBe("string");
        expect(token.length).toBeGreaterThan(0);
    });

    it("rejects IOC orders with a non-nil expiry (guards positional arg wiring)", async () => {
        await expect(
            signCreateOrder(ctx, {
                marketIndex: 1,
                clientOrderIndex: 1,
                baseAmount: 20n,
                price: 617104,
                isAsk: false,
                orderType: 1,
                timeInForce: 0,
                reduceOnly: false,
                orderExpiry: -1, // -1 → WASM sets 28d expiry, invalid for IOC
                nonce: 0,
            }),
        ).rejects.toThrow(/OrderExpiry is invalid/);
    });

    it("rejects a baseAmount past the uint48 field width with a clear error (before the WASM's opaque one)", async () => {
        await expect(
            signCreateOrder(ctx, {
                marketIndex: 1,
                clientOrderIndex: 1,
                baseAmount: 2n ** 60n, // > 2^48-1
                price: 617104,
                isAsk: false,
                orderType: 1,
                timeInForce: 0,
                reduceOnly: false,
                orderExpiry: 0,
                nonce: 0,
            }),
        ).rejects.toThrow(/baseAmount out of range/);
    });

    it("accepts baseAmount exactly at the uint48 max", async () => {
        const signed = await signCreateOrder(ctx, {
            marketIndex: 1,
            clientOrderIndex: 1,
            baseAmount: 281474976710655n, // 2^48 - 1
            price: 617104,
            isAsk: false,
            orderType: 0, // LIMIT (avoids IOC-specific validation)
            timeInForce: 1,
            reduceOnly: false,
            orderExpiry: -1,
            nonce: 0,
        });
        expect(signed.txType).toBe(14);
    });

    it("produces an atomic cancel-all-orders tx (txType 16) for all markets", async () => {
        const signed = await signCancelAllOrders(ctx, { marketIndex: 255, nonce: 0 });
        expect(signed.txType).toBe(16);
        expect(JSON.parse(signed.txInfo).Sig).toBeTruthy();
    });
});
