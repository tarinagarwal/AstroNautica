import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalize } from "./jcs.js";

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === "string" ? utf8ToBytes(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256Bytes(data));
}

/** SHA-256 of the JCS-canonical form of a JSON value, as lowercase hex. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && SHA256_HEX.test(s);
}

/** Constant-time comparison of two hex strings of equal length. */
export function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
