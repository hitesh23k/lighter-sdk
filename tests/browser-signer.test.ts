import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { initLighterSigner } from "../src/signer/browser";
import { generateApiKey, signCancelOrder, signCreateOrder, _resetSigner, type LighterClientContext } from "../src/signer/core";

// Exercise the BROWSER loader end-to-end with the real artifacts, but through the fetch/new-Function path
// (no fs, no createRequire) — the same code that runs in a browser. Go's universal wasm_exec.js takes its
// non-Node branch under `new Function`, installing stub fs + using the global crypto Node already provides.
const SIGNER_DIR = path.join(process.cwd(), "src/signer");
const artifactsPresent =
    fs.existsSync(path.join(SIGNER_DIR, "lighterSigner.wasm")) &&
    fs.existsSync(path.join(SIGNER_DIR, "wasm_exec.js"));

let wasmBytes: Uint8Array;
let wasmExecSource: string;
const ctx: LighterClientContext = {
    url: "https://testnet.zklighter.elliot.ai",
    chainId: 300,
    apiPrivateKey: "",
    accountIndex: 1,
    apiKeyIndex: 4,
};

beforeAll(() => {
    if (!artifactsPresent) return;
    wasmBytes = new Uint8Array(fs.readFileSync(path.join(SIGNER_DIR, "lighterSigner.wasm")));
    wasmExecSource = fs.readFileSync(path.join(SIGNER_DIR, "wasm_exec.js"), "utf8");
    // Force the browser loader to re-instantiate under Go's non-Node path.
    delete (globalThis as any).Go;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe.runIf(artifactsPresent)("browser signer loader", () => {
    it("signs via injected wasmBytes + wasmExecSource (no fetch, no fs)", async () => {
        initLighterSigner({ wasmBytes, wasmExecSource });
        _resetSigner();
        const kp = await generateApiKey();
        const signed = await signCancelOrder({ ...ctx, apiPrivateKey: kp.privateKey }, { marketIndex: 1, orderIndex: 5, nonce: 0 });
        expect(signed.txType).toBe(15);
        expect(JSON.parse(signed.txInfo).Sig).toBeTruthy();
    });

    it("signs via wasmUrl + wasmExecUrl over a mocked fetch (the real browser path)", async () => {
        delete (globalThis as any).Go; // force the loader to fetch + eval wasm_exec
        const fetchMock = vi.fn(async (url: string) => {
            if (String(url).includes("wasm_exec")) {
                return { ok: true, status: 200, text: async () => wasmExecSource } as any;
            }
            return { ok: true, status: 200, arrayBuffer: async () => wasmBytes.buffer } as any;
        });
        vi.stubGlobal("fetch", fetchMock);

        initLighterSigner({ wasmUrl: "https://cdn.example/lighterSigner.wasm", wasmExecUrl: "https://cdn.example/wasm_exec.js" });
        _resetSigner();
        const kp = await generateApiKey();
        const signed = await signCreateOrder({ ...ctx, apiPrivateKey: kp.privateKey }, {
            marketIndex: 1,
            clientOrderIndex: 1,
            baseAmount: 20n,
            price: 617104,
            isAsk: false,
            orderType: 1,
            timeInForce: 0,
            reduceOnly: false,
            orderExpiry: 0,
            nonce: 0,
        });
        expect(signed.txType).toBe(14);
        expect(JSON.parse(signed.txInfo).Sig).toBeTruthy();
        // both artifacts fetched
        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes("wasm_exec"))).toBe(true);
        expect(urls.some((u) => u.includes(".wasm"))).toBe(true);
    });

    it("throws a clear error when no WASM source is provided", async () => {
        delete (globalThis as any).Go;
        initLighterSigner({ wasmExecSource }); // Go glue available but no wasm bytes/url
        _resetSigner();
        await expect(generateApiKey()).rejects.toThrow(/no WASM provided/);
    });
});
