import { defineConfig } from "tsup";

export default defineConfig({
    // Node entry (index) auto-registers the fs signer loader; browser entry (index.browser) omits it and
    // imports no Node builtins, so its bundle stays browser-clean.
    entry: ["src/index.ts", "src/index.browser.ts"],
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    // No cross-entry chunking: keep the browser bundle self-contained so it can never transitively pull
    // the Node fs loader in through a shared chunk.
    splitting: false,
    // Inject __dirname/__filename shims into the ESM build and an import.meta.url shim into the
    // CJS build so the signer's artifact-path resolution works identically in both formats.
    shims: true,
    // The signer loads a Go->WASM binary and Go's wasm_exec.js glue at runtime via fs/createRequire.
    // They must stay external files (copied into dist by scripts/copy-wasm.mjs), never bundled.
    // `ws` is an optional runtime dependency, dynamically imported only on older Node — keep it external.
    external: ["./lighterSigner.wasm", "./wasm_exec.js", "ws"],
    target: "es2022",
});
