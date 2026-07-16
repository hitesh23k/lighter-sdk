#!/usr/bin/env node
// Copies the Lighter Go->WASM signer artifacts into dist/. tsup only emits JS/d.ts, so these two
// runtime files must be copied over the bundled tree so the published package can load the signer:
//   - lighterSigner.wasm : the compiled signer (Go `wasm/` package of github.com/elliottech/lighter-go)
//   - wasm_exec.js        : Go's WASM runtime glue (vendored from the Go toolchain; re-copy when bumping Go)
//
// They are copied to the dist ROOT because tsup bundles src/index.ts into dist/index.{js,mjs}, so the
// signer's `__dirname` at runtime resolves to dist/.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = ["lighterSigner.wasm", "wasm_exec.js"];

mkdirSync(join(root, "dist"), { recursive: true });

let copied = 0;
for (const name of assets) {
    const src = join(root, "src", "signer", name);
    const dest = join(root, "dist", name);
    if (!existsSync(src)) {
        console.warn(`copy-wasm: missing ${src} (skipped) — signer will be unusable until built with scripts/build-wasm.sh`);
        continue;
    }
    copyFileSync(src, dest);
    copied += 1;
}
console.log(`copy-wasm: copied ${copied}/${assets.length} asset(s) into dist/`);
if (copied !== assets.length) {
    process.exitCode = 1;
}
