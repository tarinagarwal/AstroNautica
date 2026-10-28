import { MalformedMediaError } from "./errors.js";

export function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

export function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

export function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

export function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Reads a big-endian 64-bit unsigned integer; throws if it exceeds Number.MAX_SAFE_INTEGER. */
export function u64be(b: Uint8Array, o: number): number {
  const hi = u32be(b, o);
  const lo = u32be(b, o + 4);
  if (hi > 0x1fffff) throw new MalformedMediaError("64-bit size too large");
  return hi * 0x100000000 + lo;
}

export function writeU32le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

/** Decodes bytes as Latin-1/ASCII (no TextDecoder needed; works in every runtime). */
export function ascii(b: Uint8Array, start: number, end: number): string {
  let s = "";
  const stop = Math.min(end, b.length);
  for (let i = start; i < stop; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** True when `b` at offset `o` starts with the ASCII string `s`. */
export function startsWith(b: Uint8Array, o: number, s: string): boolean {
  if (o < 0 || o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** Searches for an ASCII needle in b[start, end). */
export function indexOfAscii(b: Uint8Array, needle: string, start = 0, end = b.length): number {
  const n = needle.length;
  const stop = Math.min(end, b.length) - n;
  const first = needle.charCodeAt(0);
  for (let i = start; i <= stop; i++) {
    if (b[i] === first && startsWith(b, i, needle)) return i;
  }
  return -1;
}

/** Concatenates byte ranges into a new array. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Accepts any ArrayBufferView/ArrayBuffer and returns a Uint8Array view (no copy). */
export function toBytes(input: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}
