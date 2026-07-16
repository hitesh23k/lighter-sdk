/**
 * Node-facing signer aggregate. Importing this registers the fs-based WASM loader (via `./node`) and
 * re-exports the environment-neutral signing API from `./core`. This is the import path the SDK root and
 * the REST client use; browser code imports `./core` + `./browser` instead (no `fs`).
 */
import "./node"; // side effect: registers the Node WASM instantiator

export { setSignerArtifactDir } from "./node";
export * from "./core";
