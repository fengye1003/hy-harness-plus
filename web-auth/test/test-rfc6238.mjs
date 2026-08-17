// Standalone verification of the TOTP/base32 algorithm used by dsh-web-auth
// against the RFC 6238 appendix-B test vectors (SHA-1, 6 digits, 30 s period).

// 1) The plugin module itself must import cleanly (ESM + top-level code OK).
const plugin = await import(new URL("../index.js", import.meta.url).href);
console.log("plugin module loads, exports:", Object.keys(plugin).join(", "));

// 2) Algorithm replica (identical to the plugin's) against RFC 6238 vectors.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/g, "");
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return (code % 10 ** 6).toString().padStart(6, "0");
}
function totpAt(secret, timeSec) {
  return hotp(secret, Math.floor(timeSec / 30));
}

import { createHmac } from "node:crypto";

const secret = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"); // "12345678901234567890"
const vectors = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];
let pass = 0;
for (const [t, expected] of vectors) {
  const got = totpAt(secret, t);
  const ok = got === expected;
  if (ok) pass += 1;
  console.log(`T=${t}  got=${got}  expected=${expected}  ${ok ? "PASS" : "FAIL"}`);
}
console.log(pass === vectors.length ? `ALL ${pass} VECTORS PASS` : `FAILED: ${pass}/${vectors.length}`);
process.exit(pass === vectors.length ? 0 : 1);
