/**
 * The self-serve API key format.
 *
 *   rg_live_<24 base62><6 base62>      38 chars
 *   rg_test_<24 base62><6 base62>
 *
 * The trailing six characters are a CRC32 of everything before them, base62
 * encoded. That makes a key SELF-VALIDATING: this service can confirm a key
 * came from its own generator without keeping a list of issued keys, because
 * the check is arithmetic rather than a lookup. Nothing is stored, so nothing
 * can leak, and there is no revocation because there is no record.
 *
 * ── What this is and is not ────────────────────────────────────────────────
 *
 * A checksum is NOT a signature. The algorithm is public, it ships in
 * web/assets/js/console.js, and anyone who reads either file can mint as many
 * valid keys as they like. That is the intended design — the console hands them
 * out on request — but it has one consequence that must never be forgotten:
 *
 *   A well-formed key identifies NOBODY. It proves only that someone can read.
 *
 * So per-key rate limits are not a cost ceiling here. A caller who hits their
 * daily cap can mint a fresh key and start over, for free, forever. The only
 * real ceiling is the GLOBAL one applied across every self-serve key at once
 * (see ratelimit.ts / SELF_SERVE_GLOBAL_PER_DAY). Per-key limits remain useful
 * for keeping one careless script from monopolising a warm worker, and that is
 * all they do.
 *
 * If this endpoint ever needs to answer "who", this format cannot do it. Sign
 * the keys or store them; do not add fields to the checksum and hope.
 *
 * This file must stay byte-for-byte behaviour-identical to the generator in
 * web/assets/js/console.js. scripts/check-keyformat.mjs asserts that.
 */
import { createHash } from "node:crypto";

const A62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function base62(n: number, len: number): string {
  let s = "";
  do {
    s = A62[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  while (s.length < len) s = "0" + s;
  return s;
}

export type KeyMode = "live" | "test";

export type ParsedKey =
  | { ok: true; mode: KeyMode; bucket: string }
  | { ok: false; reason: "shape" | "checksum" };

const SHAPE = /^rg_(live|test)_([0-9A-Za-z]{24})([0-9A-Za-z]{6})$/;

/**
 * Parse and verify a self-serve key.
 *
 * The `checksum` failure is worth distinguishing from `shape`: it almost always
 * means a truncated or mistyped copy-paste of a real key, and telling someone
 * "this key is malformed" sends them to look at their clipboard instead of at
 * their account.
 *
 * `bucket` is a short digest of the key, used as the rate-limit identity. The
 * key itself never leaves this function — not into a map, not into a log line.
 */
export function parseKey(raw: string): ParsedKey {
  const m = SHAPE.exec(raw);
  if (!m) return { ok: false, reason: "shape" };
  const [, mode, body, sum] = m as unknown as [string, KeyMode, string, string];
  if (base62(crc32(`rg_${mode}_${body}`), 6) !== sum) {
    return { ok: false, reason: "checksum" };
  }
  return {
    ok: true,
    mode,
    bucket: `self:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`,
  };
}

/** Mint a key. Used only by tests and the cross-check script. */
export function makeKey(mode: KeyMode, random: () => string): string {
  const head = `rg_${mode}_${random()}`;
  return head + base62(crc32(head), 6);
}
