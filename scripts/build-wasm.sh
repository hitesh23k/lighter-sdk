#!/usr/bin/env bash
# Reproducible build of the Lighter Go signer to WebAssembly.
#
# Compiles github.com/elliottech/lighter-go's `wasm/` package to GOOS=js GOARCH=wasm and vendors the
# result plus Go's matching wasm_exec.js into src/signer/. Run this to refresh the signer when upstream
# changes the tx format or ABI, then commit the regenerated artifacts and update CHECKSUMS.txt.
#
# Requirements: Go toolchain (matching LIGHTER_GO_GO_VERSION below), git, shasum.
#
# NOTE ON REPRODUCIBILITY: byte-identical output requires the SAME upstream commit AND the SAME Go
# toolchain version that produced the currently-vendored artifact. Pin both before relying on a
# hash match. Set LIGHTER_GO_REF to build a specific tag/commit.
set -euo pipefail

# --- pinned upstream reference (update deliberately, then re-verify downstream signing tests) ---
LIGHTER_GO_REPO="${LIGHTER_GO_REPO:-https://github.com/elliottech/lighter-go.git}"
LIGHTER_GO_REF="${LIGHTER_GO_REF:-main}"   # TODO: pin to the exact tag/commit that produced the vendored .wasm

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/src/signer"

command -v go >/dev/null 2>&1 || { echo "build-wasm: Go toolchain not found on PATH" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "build-wasm: git not found on PATH" >&2; exit 1; }

echo "build-wasm: Go version: $(go version)"
echo "build-wasm: building ${LIGHTER_GO_REPO}@${LIGHTER_GO_REF}"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

git clone --quiet "${LIGHTER_GO_REPO}" "${WORK}/lighter-go"
git -C "${WORK}/lighter-go" checkout --quiet "${LIGHTER_GO_REF}"
BUILT_COMMIT="$(git -C "${WORK}/lighter-go" rev-parse HEAD)"

# Compile the wasm/ package.
( cd "${WORK}/lighter-go" && GOOS=js GOARCH=wasm go build -o "${OUT_DIR}/lighterSigner.wasm" ./wasm/ )

# Vendor Go's matching runtime glue. Newer Go ships it under lib/wasm; older under misc/wasm.
GOROOT="$(go env GOROOT)"
if [ -f "${GOROOT}/lib/wasm/wasm_exec.js" ]; then
    cp "${GOROOT}/lib/wasm/wasm_exec.js" "${OUT_DIR}/wasm_exec.js"
elif [ -f "${GOROOT}/misc/wasm/wasm_exec.js" ]; then
    cp "${GOROOT}/misc/wasm/wasm_exec.js" "${OUT_DIR}/wasm_exec.js"
else
    echo "build-wasm: could not locate wasm_exec.js under ${GOROOT}" >&2
    exit 1
fi

echo "build-wasm: built from commit ${BUILT_COMMIT}"
echo "build-wasm: artifact checksums —"
shasum -a 256 "${OUT_DIR}/lighterSigner.wasm" "${OUT_DIR}/wasm_exec.js"
echo "build-wasm: if these differ from CHECKSUMS.txt, re-run the signing tests before committing."
