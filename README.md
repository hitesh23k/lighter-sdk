# @hitesh23k/lighter-sdk

TypeScript/JavaScript SDK for **Lighter (zkLighter)** and the **Robinhood-Chain Lighter** deployment.

Lighter's transactions are signed with a ZK-rollup scheme (Poseidon hash over the Goldilocks field,
Schnorr-style) that has no native JavaScript implementation. This SDK ships elliottech's official Go
signer compiled to WebAssembly and loads it in-process, so signing works on any OS from one artifact —
no per-platform native binaries.

Includes a WASM-backed zk signer, a typed REST client, a WebSocket streaming client, a high-level
venue-aware convenience client, and a browser build.

## Install

```bash
npm install @hitesh23k/lighter-sdk
```

Requires Node >= 18 (uses global `fetch` and WebAssembly).

## Quick start (high-level client)

`LighterClient` resolves markets by symbol and scales human sizes/prices to Lighter's integer encoding for
you. Sizes are in tokens, prices in quote units, `long`/`short` map to the order side.

```ts
import { LighterClient } from "@hitesh23k/lighter-sdk";

const client = new LighterClient({
  venue: "zk",            // or "robinhood"
  isMainnet: true,
  signer: { apiPrivateKey: "0x…", accountIndex: 7, apiKeyIndex: 4 },
});

await client.loadMarkets();

await client.setLeverage({ symbol: "BTC", leverage: 20 });
await client.placeMarketOrder({ symbol: "BTC", side: "long", size: 0.5, slippage: 0.01 });
await client.placeLimitOrder({ symbol: "ETH", side: "short", size: 2, price: 3050.5 });

const positions = await client.getPositions();

await client.connect();
client.streamOrderBook("BTC", (msg) => console.log(msg.type, msg));
```

Everything low-level is still reachable via `client.rest` and `client.ws`. The sections below document
those directly.

## Signer usage

```ts
import { generateApiKey, signCreateOrder, setLogger } from "@hitesh23k/lighter-sdk";

setLogger(console); // optional — the SDK is silent by default

const kp = await generateApiKey();
const ctx = {
  url: "https://mainnet.zklighter.elliot.ai",
  chainId: 304,            // 304 zk mainnet · 300 testnet · 466324 robinhood mainnet
  apiPrivateKey: kp.privateKey,
  accountIndex: 1,
  apiKeyIndex: 4,          // programmatic keys use index >= 4
};

const signed = await signCreateOrder(ctx, {
  marketIndex: 1,
  clientOrderIndex: Date.now(),
  baseAmount: 20n,         // integer scaled by the market's size_decimals
  price: 617104,           // integer scaled by price_decimals (0 for market/IOC)
  isAsk: false,
  orderType: 1,            // MARKET
  timeInForce: 0,          // IOC
  reduceOnly: false,
  orderExpiry: 0,          // NilOrderExpiry required for IOC
  nonce: 0,
});
// POST { tx_type: signed.txType, tx_info: signed.txInfo } to /api/v1/sendTx
```

If your bundler relocates the SDK away from its `.wasm`/`wasm_exec.js` artifacts, point the signer at
them with `setSignerArtifactDir("/abs/path/to/artifacts")` or the `LIGHTER_SIGNER_DIR` env var.

## REST client

```ts
import { LighterRestClient } from "@hitesh23k/lighter-sdk";

const client = new LighterRestClient({ venue: "zk", isMainnet: true });

const markets = await client.getOrderBookDetails();     // public read
const account = await client.getAccount(7);

const signer = { apiPrivateKey: "0x…", accountIndex: 7, apiKeyIndex: 4 };
await client.createLimitOrder(signer, {
  marketIndex: 1, baseAmount: 100n, price: 500000, isAsk: false, clientOrderIndex: Date.now(),
});
await client.updateLeverage(signer, { marketIndex: 1, leverage: 20 });
```

Pass `{ integrator: { accountIndex, takerFee, makerFee } }` to attach a builder fee to orders sent with
`applyIntegratorFee: true` (the account must have approved the integrator on-chain first).

## WebSocket streams

```ts
import { LighterWs } from "@hitesh23k/lighter-sdk";

const ws = new LighterWs({ venue: "zk", isMainnet: true, readonly: true });
ws.on("error", (e) => console.error(e));
await ws.connect();

const off = ws.subscribeOrderBook(1, (msg) => console.log(msg.type, msg));
ws.subscribeTrades(1, (msg) => { /* … */ });
ws.subscribeAccountAll(7, (msg) => { /* balances, positions, orders */ });

// later
off();
ws.close();
```

Reconnect (with backoff), re-subscription, and keepalive are automatic. In the browser the global
`WebSocket` is used; on Node < 22 the SDK uses the optional `ws` package (install it, or pass
`{ WebSocketImpl }`).

## Browser usage

Import from the `/browser` entry. The REST and WebSocket clients work unchanged (global `fetch` /
`WebSocket`); the only difference is the signer, which has no filesystem — you hand it the WASM artifacts
by URL once at startup. Both `lighterSigner.wasm` and `wasm_exec.js` ship in the package's `dist/`.

```ts
import { initLighterSigner, LighterRestClient } from "@hitesh23k/lighter-sdk/browser";
// With Vite (or any bundler that returns an asset URL for these files):
import wasmUrl from "@hitesh23k/lighter-sdk/lighterSigner.wasm?url";
import wasmExecUrl from "@hitesh23k/lighter-sdk/wasm_exec.js?url";

initLighterSigner({ wasmUrl, wasmExecUrl }); // lazy — the WASM loads on the first signing call

const client = new LighterRestClient({ venue: "zk", isMainnet: true });
// ... sign/read/stream exactly as in Node
```

You can also pass `wasmBytes` / `wasmExecSource` directly instead of URLs. The browser bundle imports no
Node built-ins, so it bundles cleanly for the web.

## Building the signer artifacts

The compiled `lighterSigner.wasm` and Go's `wasm_exec.js` are vendored in `src/signer/`. To rebuild:

```bash
npm run build:wasm   # clones elliottech/lighter-go, compiles wasm/, vendors wasm_exec.js
npm run checksum     # verify artifacts against CHECKSUMS.txt
```

## License

Apache-2.0. Bundled third-party components (the Lighter Go signer and Go's WASM glue) are attributed in
[NOTICE](./NOTICE).
