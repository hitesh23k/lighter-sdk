/**
 * Per-(account:apiKey) nonce sequencer for Lighter's signed write path.
 *
 * Lighter transactions from one api key must carry strictly increasing, contiguous nonces, and the
 * sequencer rejects reuse. Fetching `nextNonce` per call and signing races under any concurrency: two
 * overlapping writes both read the same server nonce and one is silently rejected. This serializes
 * sign+send per key, advances a local nonce only on success, and resyncs from the server on any failure
 * (so a non-nonce error doesn't leave a permanent gap).
 */
export default class NonceManager {
    /** Next nonce to use per key; absent = must (re)fetch from the server. */
    private next: Map<string, number> = new Map();
    /** Tail of the per-key serialization chain (never rejects — errors surface via the returned promise). */
    private tail: Map<string, Promise<unknown>> = new Map();

    constructor(private readonly fetchNext: (accountIndex: number, apiKeyIndex: number) => Promise<number>) {}

    private key(accountIndex: number, apiKeyIndex: number): string {
        return `${accountIndex}:${apiKeyIndex}`;
    }

    /**
     * Run `fn(nonce)` (which must sign AND send the tx) under an exclusive, correctly-sequenced nonce for
     * this key. Calls are serialized: a second concurrent write waits for the first to finish, guaranteeing
     * distinct increasing nonces. The local nonce advances only when `fn` resolves; on rejection it is
     * cleared so the next call refetches from the server.
     */
    public async withNonce<T>(accountIndex: number, apiKeyIndex: number, fn: (nonce: number) => Promise<T>): Promise<T> {
        const key = this.key(accountIndex, apiKeyIndex);
        const prior = this.tail.get(key) ?? Promise.resolve();
        const run = prior.then(async () => {
            let nonce = this.next.get(key);
            if (nonce === undefined) {
                nonce = await this.fetchNext(accountIndex, apiKeyIndex);
            }
            try {
                const result = await fn(nonce);
                this.next.set(key, nonce + 1); // advance only after a successful send
                return result;
            } catch (error) {
                this.next.delete(key); // resync from the server on the next call
                throw error;
            }
        });
        // The lock chain must never reject, or it would poison every subsequent call for this key.
        this.tail.set(key, run.then(() => undefined, () => undefined));
        return run;
    }

    /** Force a resync (drop the local nonce) for a key — e.g. after an out-of-band nonce error. */
    public resync(accountIndex: number, apiKeyIndex: number): void {
        this.next.delete(this.key(accountIndex, apiKeyIndex));
    }
}
