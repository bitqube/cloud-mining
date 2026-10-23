import { createHash } from "node:crypto";

// BitQube mainnet addresses: Base58Check, version byte 25 ('B', P2PKH) or 85 ('b',
// P2SH). The pool pays the worker name verbatim, so a typo here means lost payouts.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const P2PKH = 25;
const P2SH = 85;

function base58Decode(s: string): Buffer | null {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

export function isValidBtqAddress(address: string): boolean {
  const a = address.trim();
  if (a.length < 26 || a.length > 35) return false;
  const raw = base58Decode(a);
  if (!raw || raw.length !== 25) return false;
  const payload = raw.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  if (!checksum.equals(raw.subarray(21))) return false;
  return payload[0] === P2PKH || payload[0] === P2SH;
}
