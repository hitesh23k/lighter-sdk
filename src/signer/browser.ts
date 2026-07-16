import { _setSignerInstantiator, finalizeExports, type LighterWasmExports } from "./core";

/**
 * Browser WASM loader for the signer. There is no filesystem in the browser, so the caller provides the
 * artifacts by URL (fetched) or as bytes/source. Both `lighterSigner.wasm` and Go's `wasm_exec.js` ship in
 * this package's `dist/`; a bundler can hand you their URLs (e.g. Vite `import wasmUrl from '…/lighterSigner.wasm?url'`).
 *
 * Call `initLighterSigner(...)` once at startup; the WASM is instantiated lazily on the first signing call.
 */
export interface BrowserSignerInit {
    /** URL to `lighterSigner.wasm`. Required unless `wasmBytes` is given. */
    wasmUrl?: string | URL;
    /** URL to Go's `wasm_exec.js`. Required unless `wasmExecSource` is given or `globalThis.Go` already exists. */
    wasmExecUrl?: string | URL;
    /** Raw WASM bytes (alternative to `wasmUrl`). */
    wasmBytes?: ArrayBuffer | Uint8Array;
    /** Raw `wasm_exec.js` source (alternative to `wasmExecUrl`). */
    wasmExecSource?: string;
}

async function ensureGoRuntime(init: BrowserSignerInit): Promise<any> {
    const g = globalThis as any;
    if (typeof g.Go === "function") return g.Go;
    let source = init.wasmExecSource;
    if (!source) {
        if (!init.wasmExecUrl) {
            throw new Error(
                "LighterSigner::browser::Go runtime glue unavailable. Provide wasmExecUrl or wasmExecSource " +
                    "(from this package's dist/wasm_exec.js), or preload it so globalThis.Go is defined.",
            );
        }
        const res = await fetch(String(init.wasmExecUrl));
        if (!res.ok) throw new Error(`LighterSigner::browser::failed to fetch wasm_exec.js (${res.status})`);
        source = await res.text();
    }
    // Go's wasm_exec.js is a classic script that assigns globalThis.Go. Run it once; in the browser it
    // takes the non-Node code path (no `require`/`process`) and installs the runtime on globalThis.
    // eslint-disable-next-line no-new-func
    new Function(source)();
    if (typeof g.Go !== "function") {
        throw new Error("LighterSigner::browser::wasm_exec.js did not register globalThis.Go");
    }
    return g.Go;
}

async function resolveWasmBytes(init: BrowserSignerInit): Promise<BufferSource> {
    if (init.wasmBytes) return init.wasmBytes as BufferSource;
    if (!init.wasmUrl) {
        throw new Error("LighterSigner::browser::no WASM provided. Pass wasmUrl or wasmBytes.");
    }
    const res = await fetch(String(init.wasmUrl));
    if (!res.ok) throw new Error(`LighterSigner::browser::failed to fetch lighterSigner.wasm (${res.status})`);
    return res.arrayBuffer();
}

async function browserInstantiate(init: BrowserSignerInit): Promise<LighterWasmExports> {
    const GoRuntime = await ensureGoRuntime(init);
    const go = new GoRuntime();
    const bytes = await resolveWasmBytes(init);
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    // Do not await go.run — the Go program ends in `select {}` and stays resident to serve exports.
    void go.run(instance);
    // Give the runtime a tick to register its globals.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return finalizeExports(globalThis);
}

/**
 * Register the browser signer loader. Idempotent — call again to change the artifact source; the next
 * signing call re-instantiates. Does not fetch immediately; instantiation is lazy on first sign.
 */
export function initLighterSigner(init: BrowserSignerInit): void {
    _setSignerInstantiator(() => browserInstantiate(init));
}
