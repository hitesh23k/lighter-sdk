import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // The signer instantiates a resident ~14MB Go WASM runtime; give it room and keep a single worker
        // so the shared globalThis.Go registration isn't raced across parallel test files.
        testTimeout: 30000,
        hookTimeout: 30000,
        pool: "forks",
        poolOptions: { forks: { singleFork: true } },
    },
});
