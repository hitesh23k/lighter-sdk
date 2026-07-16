import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { _setSignerInstantiator, _resetSigner, finalizeExports, type LighterWasmExports } from "./core";

/**
 * Node WASM loader for the signer. Reads `lighterSigner.wasm` + Go's `wasm_exec.js` from disk and
 * instantiates them in-process. Importing this module registers the loader (side effect), which is why the
 * Node aggregate `./signer` imports it. Browser bundles never import this file, so `fs`/`path`/`module`
 * stay out of the browser build.
 *
 * BUILD: `GOOS=js GOARCH=wasm go build -o lighterSigner.wasm ./wasm/` from lighter-go, then copy
 * `lighterSigner.wasm` and Go's runtime glue `wasm_exec.js` next to this file (see scripts/build-wasm.sh).
 * `scripts/copy-wasm.mjs` copies both into `dist/` during build.
 */

/**
 * Directory holding `lighterSigner.wasm` + `wasm_exec.js`. Defaults to this module's own directory
 * (works for both `dist/` after build and `src/signer/` under test); a host that bundles the SDK — where
 * `__dirname` no longer points at the artifacts — can override it via `setSignerArtifactDir` or the
 * `LIGHTER_SIGNER_DIR` env var.
 */
let artifactDirOverride: string | null =
    (typeof process !== "undefined" && process.env && process.env.LIGHTER_SIGNER_DIR) || null;

/** Point the signer at the directory containing `lighterSigner.wasm` and `wasm_exec.js`. */
export function setSignerArtifactDir(dir: string): void {
    artifactDirOverride = dir;
    _resetSigner(); // force a reload so the next signing call picks up the new location.
}

function resolveArtifactDir(): string {
    return artifactDirOverride || __dirname;
}

async function nodeInstantiate(): Promise<LighterWasmExports> {
    const dir = resolveArtifactDir();
    const wasmFile = path.join(dir, "lighterSigner.wasm");
    const wasmExecGlue = path.join(dir, "wasm_exec.js");
    if (!fs.existsSync(wasmFile) || !fs.existsSync(wasmExecGlue)) {
        throw new Error(
            `LighterSigner::Signer artifacts missing. Expected ${wasmFile} and ${wasmExecGlue}. ` +
                `Compile github.com/elliottech/lighter-go (wasm/ package) to WASM and place the artifacts there, ` +
                `or point the SDK at them with setSignerArtifactDir()/LIGHTER_SIGNER_DIR.`,
        );
    }
    // Go's wasm_exec.js runtime glue registers the global `Go` used to instantiate the module. It is a
    // CommonJS script (it `require`s node's fs/crypto internally), so load it through a real CJS require
    // built from this module's path — works from both the CJS and ESM builds.
    const nodeRequire = createRequire(__filename);
    nodeRequire(wasmExecGlue);
    const GoRuntime = (globalThis as any).Go;
    if (!GoRuntime) {
        throw new Error("LighterSigner::Go WASM runtime glue did not register globalThis.Go");
    }
    const go = new GoRuntime();
    const bytes = fs.readFileSync(wasmFile);
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    // Do not await go.run — the Go program ends in `select {}` and stays resident to serve exports.
    void go.run(instance);
    // Give the runtime a tick to register its globals.
    await new Promise((resolve) => setImmediate(resolve));
    return finalizeExports(globalThis);
}

_setSignerInstantiator(nodeInstantiate);
