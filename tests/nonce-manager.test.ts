import { describe, it, expect, vi } from "vitest";
import NonceManager from "../src/rest/nonce-manager";

describe("NonceManager", () => {
    it("serializes concurrent calls into contiguous nonces, fetching the seed once", async () => {
        const fetchNext = vi.fn(async () => 10);
        const nm = new NonceManager(fetchNext);
        const used: number[] = [];
        await Promise.all(
            Array.from({ length: 5 }, () =>
                nm.withNonce(1, 4, async (nonce) => {
                    used.push(nonce);
                }),
            ),
        );
        expect(used.sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
        expect(fetchNext).toHaveBeenCalledTimes(1); // seeded once, advanced locally
    });

    it("advances only on success and resyncs (refetches) after a failure", async () => {
        let seed = 50;
        const fetchNext = vi.fn(async () => seed);
        const nm = new NonceManager(fetchNext);

        const n0 = await nm.withNonce(1, 4, async (nonce) => nonce); // 50, success -> local advances to 51
        expect(n0).toBe(50);

        seed = 70; // if it refetches, it'll get this
        await expect(
            nm.withNonce(1, 4, async () => {
                throw new Error("send failed");
            }),
        ).rejects.toThrow("send failed"); // used 51, then resync (drops local)

        const n2 = await nm.withNonce(1, 4, async (nonce) => nonce);
        expect(n2).toBe(70); // refetched from server, not reused 52
        expect(fetchNext).toHaveBeenCalledTimes(2);
    });

    it("keeps separate sequences per account:apiKey", async () => {
        const fetchNext = vi.fn(async (a: number, k: number) => a * 100 + k);
        const nm = new NonceManager(fetchNext);
        const a = await nm.withNonce(1, 4, async (n) => n);
        const b = await nm.withNonce(2, 4, async (n) => n);
        const a2 = await nm.withNonce(1, 4, async (n) => n);
        expect(a).toBe(104);
        expect(b).toBe(204);
        expect(a2).toBe(105); // key (1,4) advanced independently of (2,4)
    });

    it("a lock does not poison the key after a failure (next call still runs)", async () => {
        const nm = new NonceManager(async () => 0);
        await expect(nm.withNonce(1, 4, async () => { throw new Error("x"); })).rejects.toThrow("x");
        const ok = await nm.withNonce(1, 4, async (n) => `ran:${n}`);
        expect(ok).toBe("ran:0");
    });
});
