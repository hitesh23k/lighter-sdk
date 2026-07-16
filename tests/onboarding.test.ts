import { describe, it, expect, vi } from "vitest";
import "../src/signer/node"; // register the Node WASM loader (the SDK root does this; onboarding uses core)
import LighterOnboarding, { type PendingApiKeyRegistration } from "../src/onboarding";

function fakeRest(overrides: Record<string, any> = {}) {
    return {
        getAccountsByL1Address: vi.fn(async () => [{ account_index: 42 }]),
        getApiKeys: vi.fn(async () => [{ api_key_index: 0 }, { api_key_index: 4 }]),
        sendChangePubKey: vi.fn(async () => ({ code: 200, tx_hash: "0xcpk" })),
        getActiveOrders: vi.fn(async () => []),
        ...overrides,
    };
}

// testnet so the real WASM signs against chainId 300 (prepareApiKey loads the signer)
const onb = (rest: any) => new LighterOnboarding({ venue: "zk", isMainnet: false, restClient: rest });

describe("LighterOnboarding account + slot resolution", () => {
    it("resolves the account index from an L1 address", async () => {
        const rest = fakeRest();
        expect(await onb(rest).resolveAccountIndex("0xabc")).toBe(42);
    });

    it("supports the sub_accounts `index` field shape", async () => {
        const rest = fakeRest({ getAccountsByL1Address: vi.fn(async () => [{ index: 7 }]) });
        expect(await onb(rest).resolveAccountIndex("0xabc")).toBe(7);
    });

    it("throws when the wallet has no Lighter account", async () => {
        const rest = fakeRest({ getAccountsByL1Address: vi.fn(async () => []) });
        await expect(onb(rest).resolveAccountIndex("0xabc")).rejects.toThrow(/no Lighter account found/);
    });

    it("picks the lowest free api_key_index >= 4", async () => {
        // slots 0 and 4 used -> next free is 5
        expect(await onb(fakeRest()).findFreeApiKeyIndex(42)).toBe(5);
        // nothing used -> 4
        expect(await onb(fakeRest({ getApiKeys: vi.fn(async () => []) })).findFreeApiKeyIndex(42)).toBe(4);
    });
});

describe("LighterOnboarding prepareApiKey (real WASM ChangePubKey)", () => {
    it("generates a key and L2-signs a ChangePubKey with an L1Sig placeholder", async () => {
        const rest = fakeRest();
        const pending = await onb(rest).prepareApiKey({ accountIndex: 42 });
        expect(pending.accountIndex).toBe(42);
        expect(pending.apiKeyIndex).toBe(5); // free slot
        expect(pending.apiPrivateKey).toMatch(/^0x?[0-9a-fA-F]+$/);
        expect(pending.publicKey.length).toBeGreaterThan(0);
        expect(pending.txType).toBe(8);
        expect(pending.txInfo).toContain('"L1Sig":""');
        expect(pending.messageToSign.length).toBeGreaterThan(0);
    });

    it("honours an explicit apiKeyIndex", async () => {
        const pending = await onb(fakeRest()).prepareApiKey({ accountIndex: 42, apiKeyIndex: 9 });
        expect(pending.apiKeyIndex).toBe(9);
    });
});

describe("LighterOnboarding submitApiKey (L1 splice + submit)", () => {
    const pending: PendingApiKeyRegistration = {
        accountIndex: 42,
        apiKeyIndex: 5,
        apiPrivateKey: "0xkey",
        publicKey: "0xpub",
        txType: 8,
        txInfo: '{"AccountIndex":42,"PubKey":"0xpub","L1Sig":"","Nonce":0}',
        messageToSign: "Register Lighter Account",
    };

    it("splices the L1 signature into the placeholder and submits tx 8", async () => {
        const rest = fakeRest();
        const { txHash, signer } = await onb(rest).submitApiKey(pending, "0xL1SIGNATURE");
        expect(rest.sendChangePubKey).toHaveBeenCalledTimes(1);
        const [txType, mergedTxInfo] = rest.sendChangePubKey.mock.calls[0];
        expect(txType).toBe(8);
        expect(mergedTxInfo).toContain('"L1Sig":"0xL1SIGNATURE"');
        expect(mergedTxInfo).not.toContain('"L1Sig":""');
        expect(txHash).toBe("0xcpk");
        expect(signer).toEqual({ apiPrivateKey: "0xkey", accountIndex: 42, apiKeyIndex: 5 });
    });

    it("rejects a missing L1 signature", async () => {
        await expect(onb(fakeRest()).submitApiKey(pending, "")).rejects.toThrow(/l1Signature is required/);
    });

    it("rejects a malformed pending tx (no placeholder)", async () => {
        const bad = { ...pending, txInfo: '{"L1Sig":"already-set"}' };
        await expect(onb(fakeRest()).submitApiKey(bad, "0xsig")).rejects.toThrow(/missing L1Sig placeholder/);
    });
});

describe("LighterOnboarding registerApiKey (full flow)", () => {
    it("resolves account, signs, obtains L1 signature, submits, returns the signer", async () => {
        const rest = fakeRest();
        const l1Sign = vi.fn(async (msg: string) => `sig(${msg.slice(0, 8)})`);
        const out = await onb(rest).registerApiKey({ l1Address: "0xowner", l1Sign });
        expect(rest.getAccountsByL1Address).toHaveBeenCalledWith("0xowner");
        expect(l1Sign).toHaveBeenCalledTimes(1);
        expect(rest.sendChangePubKey).toHaveBeenCalledTimes(1);
        expect(out.accountIndex).toBe(42);
        expect(out.apiKeyIndex).toBe(5);
        expect(out.apiPrivateKey).toMatch(/^0x?[0-9a-fA-F]+$/);
        expect(out.signer).toEqual({ apiPrivateKey: out.apiPrivateKey, accountIndex: 42, apiKeyIndex: 5 });
    });

    it("requires accountIndex or l1Address", async () => {
        await expect(onb(fakeRest()).registerApiKey({ l1Sign: async () => "s" } as any)).rejects.toThrow(/requires accountIndex or l1Address/);
    });
});

describe("LighterOnboarding verifyApiKey", () => {
    it("true when an authed read succeeds, false when it throws", async () => {
        expect(await onb(fakeRest()).verifyApiKey({ apiPrivateKey: "k", accountIndex: 42, apiKeyIndex: 5 })).toBe(true);
        const rest = fakeRest({ getActiveOrders: vi.fn(async () => { throw new Error("api key not found"); }) });
        expect(await onb(rest).verifyApiKey({ apiPrivateKey: "k", accountIndex: 42, apiKeyIndex: 5 })).toBe(false);
    });
});
