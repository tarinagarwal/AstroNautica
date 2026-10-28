/** Byte helpers tuned for Hermes (no Buffer): table-driven base64 that builds strings in chunks. */

const ENC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENC_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DEC = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  DEC[ENC.charCodeAt(i)] = i;
  DEC[ENC_URL.charCodeAt(i)] = i;
}

export function bytesToBase64(bytes: Uint8Array, urlSafe = false): string {
  const T = urlSafe ? ENC_URL : ENC;
  const parts: string[] = [];
  let chunk = "";
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += T[v >> 18]! + T[(v >> 12) & 63]! + T[(v >> 6) & 63]! + T[v & 63]!;
    if (chunk.length >= 16384) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (i < n) {
    const a = bytes[i]!;
    const b = i + 1 < n ? bytes[i + 1]! : 0;
    const v = (a << 16) | (b << 8);
    chunk += T[v >> 18]! + T[(v >> 12) & 63]!;
    chunk += i + 1 < n ? T[(v >> 6) & 63]! : urlSafe ? "" : "=";
    chunk += urlSafe ? "" : "=";
  }
  parts.push(chunk);
  return parts.join("");
}

/** Decodes standard or URL-safe base64, with or without padding. Throws on invalid input. */
export function base64ToBytes(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--; // '='
  if (len % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const a = DEC[s.charCodeAt(i)]!;
    const b = DEC[s.charCodeAt(i + 1)]!;
    const c = DEC[s.charCodeAt(i + 2)]!;
    const d = DEC[s.charCodeAt(i + 3)]!;
    if ((a | b | c | d) < 0) throw new Error("invalid base64 character");
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  const rest = len - i;
  if (rest >= 2) {
    const a = DEC[s.charCodeAt(i)]!;
    const b = DEC[s.charCodeAt(i + 1)]!;
    const c = rest === 3 ? DEC[s.charCodeAt(i + 2)]! : 0;
    if ((a | b | c) < 0) throw new Error("invalid base64 character");
    const v = (a << 18) | (b << 12) | (c << 6);
    out[o++] = v >> 16;
    if (rest === 3) out[o++] = (v >> 8) & 255;
  }
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

let counter = 0;
/** A process-unique id for native request handles. */
export function nextId(prefix: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
