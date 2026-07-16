#!/usr/bin/env node
// Verifies the vendored signer artifacts match src/signer/CHECKSUMS.txt. Guards against a corrupted or
// accidentally-swapped .wasm reaching users (a wrong signer silently produces invalid signatures).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const signerDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "signer");
const checksumFile = join(signerDir, "CHECKSUMS.txt");

const expected = new Map();
for (const line of readFileSync(checksumFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hash, name] = trimmed.split(/\s+/);
    if (hash && name) expected.set(name, hash);
}

let failed = false;
for (const [name, want] of expected) {
    const buf = readFileSync(join(signerDir, name));
    const got = createHash("sha256").update(buf).digest("hex");
    if (got === want) {
        console.log(`ok   ${name}`);
    } else {
        console.error(`FAIL ${name}\n  expected ${want}\n  got      ${got}`);
        failed = true;
    }
}

if (failed) {
    console.error("verify-checksums: artifact checksum mismatch");
    process.exit(1);
}
console.log("verify-checksums: all artifacts match");
