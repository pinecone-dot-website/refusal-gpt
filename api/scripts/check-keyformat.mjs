#!/usr/bin/env node
/**
 * Assert that the server's key parser agrees with the browser's key generator.
 *
 *   node scripts/check-keyformat.mjs
 *
 * These are two independent implementations of the same CRC32-over-base62
 * scheme, in two languages, in two directories, maintained by whoever is
 * nearest. If they ever drift, every key the console hands out is rejected by
 * the API with no clue as to why — the key looks right, the checksum is right
 * for one of them, and nothing logs the disagreement.
 *
 * So this mints keys with the REAL browser generator (loaded out of
 * web/assets/js/console.js, not a copy) and feeds them to the REAL server
 * parser. Run it in CI, or at least before deploying either side.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseKey, crc32, base62 } from "../dist/keyformat.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_JS = path.resolve(HERE, "../../web/assets/js/console.js");

// Pull the generator out of the browser bundle and run it here. Slicing at the
// storage section keeps the DOM half out; everything above it is pure.
const src = readFileSync(CONSOLE_JS, "utf8");
const pure = src.slice(src.indexOf("var A62"), src.indexOf("// ── storage"));
if (!pure.includes("function makeKey")) {
  console.error("  console.js no longer exposes makeKey where expected — update this script.");
  process.exit(1);
}
// Node 18+ already exposes webcrypto as globalThis.crypto, which is what the
// browser generator calls for getRandomValues.
const browser = new Function(pure + "\nreturn { makeKey, validKey, crc32, b62 };")();

let failures = 0;
const fail = (m) => { console.error(`  FAIL  ${m}`); failures++; };

// 1. primitives agree
for (const s of ["", "a", "rg_live_", "The last model", "éè", "0".repeat(64)]) {
  if (browser.crc32(s) !== crc32(s)) fail(`crc32 mismatch on ${JSON.stringify(s)}`);
}
for (const n of [0, 1, 61, 62, 3843, 4294967295]) {
  if (browser.b62(n, 6) !== base62(n, 6)) fail(`base62 mismatch on ${n}`);
}

// 2. every key the browser mints, the server accepts — both modes, many keys
for (const mode of ["live", "test"]) {
  for (let i = 0; i < 5000; i++) {
    const k = browser.makeKey(mode);
    const p = parseKey(k);
    if (!p.ok) { fail(`server rejected a browser key (${p.reason}): ${k}`); break; }
    if (p.mode !== mode) { fail(`mode mismatch: ${k} parsed as ${p.mode}`); break; }
  }
}

// 3. tampering is caught by both
const good = browser.makeKey("live");
const cases = [
  ["truncated", good.slice(0, -1)],
  ["extended", good + "x"],
  ["flipped body char", good.slice(0, 10) + (good[10] === "A" ? "B" : "A") + good.slice(11)],
  ["flipped checksum", good.slice(0, -1) + (good.slice(-1) === "A" ? "B" : "A")],
  ["wrong prefix", good.replace("rg_live_", "rg_prod_")],
  ["mode swapped", "rg_test_" + good.slice(8)],
  ["empty", ""],
  ["not a key", "sk-proj-abc123"],
];
for (const [name, k] of cases) {
  if (parseKey(k).ok) fail(`server ACCEPTED a bad key (${name}): ${k}`);
  if (browser.validKey(k)) fail(`browser ACCEPTED a bad key (${name}): ${k}`);
}

// 4. the bucket id is stable and never contains the key
const p = parseKey(good);
if (!p.ok || p.bucket === parseKey(browser.makeKey("live")).bucket) fail("bucket ids collide");
if (p.ok && good.slice(8, 20).length && p.bucket.includes(good.slice(8, 20))) {
  fail("bucket id leaks key material");
}

if (failures) {
  console.error(`\n  ${failures} failure(s). The console and the API disagree about keys.\n`);
  process.exit(1);
}
console.log("  browser generator and server parser agree (10,000 keys, 8 tamper cases)");
