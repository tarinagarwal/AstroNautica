/**
 * Language-level polyfills for Hermes. Each one is installed only when the engine lacks it, and each is plain
 * TypeScript so it is tested in Node by removing the global first.
 *
 * - TextDecoder / TextEncoder (UTF-8): nostr-tools creates a TextDecoder at module load; core decodes manifests.
 * - structuredClone: packages/schema `approvalBody()` clones with it (JSON-shaped data plus typed arrays).
 * - Promise.any / AggregateError: core `fetchVerified` and nostr-tools race with it.
 * - atob / btoa: core NIP-98 headers and invite links.
 */

const g = globalThis as Record<string, any>;

export class Utf8TextEncoder {
  readonly encoding = "utf-8";
  encode(input = ""): Uint8Array {
    const s = String(input);
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        } else c = 0xfffd;
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }
  encodeInto(input: string, dest: Uint8Array): { read: number; written: number } {
    const bytes = this.encode(input);
    const n = Math.min(bytes.length, dest.length);
    dest.set(bytes.subarray(0, n));
    return { read: input.length, written: n };
  }
}

export class Utf8TextDecoder {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label = "utf-8", opts: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!/^utf-?8$/i.test(label.trim())) throw new RangeError(`unsupported encoding: ${label}`);
    this.fatal = !!opts.fatal;
    this.ignoreBOM = !!opts.ignoreBOM;
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return "";
    const b =
      input instanceof Uint8Array
        ? input
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
    let i = 0;
    if (!this.ignoreBOM && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
    const parts: string[] = [];
    let codes: number[] = [];
    const bad = () => {
      if (this.fatal) throw new TypeError("invalid UTF-8");
      codes.push(0xfffd);
    };
    // The WHATWG UTF-8 decoder: maximal subparts are replaced, an unexpected byte is processed again.
    let cp = 0;
    let needed = 0;
    let seen = 0;
    let lower = 0x80;
    let upper = 0xbf;
    while (i < b.length) {
      const byte = b[i]!;
      if (needed === 0) {
        i++;
        if (byte <= 0x7f) codes.push(byte);
        else if (byte >= 0xc2 && byte <= 0xdf) [needed, cp] = [1, byte & 0x1f];
        else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) lower = 0xa0;
          if (byte === 0xed) upper = 0x9f;
          [needed, cp] = [2, byte & 0x0f];
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) lower = 0x90;
          if (byte === 0xf4) upper = 0x8f;
          [needed, cp] = [3, byte & 0x07];
        } else bad();
      } else if (byte < lower || byte > upper) {
        [cp, needed, seen, lower, upper] = [0, 0, 0, 0x80, 0xbf];
        bad();
      } else {
        i++;
        [lower, upper] = [0x80, 0xbf];
        cp = (cp << 6) | (byte & 0x3f);
        if (++seen === needed) {
          if (cp >= 0x10000) {
            const c = cp - 0x10000;
            codes.push(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
          } else codes.push(cp);
          [cp, needed, seen] = [0, 0, 0];
        }
      }
      if (codes.length >= 8192) {
        parts.push(String.fromCharCode(...codes));
        codes = [];
      }
    }
    if (needed !== 0) bad();
    if (codes.length) parts.push(String.fromCharCode(...codes));
    return parts.join("");
  }
}

/** Deep clone for structured data: plain objects, arrays, primitives, Date, Map, Set, ArrayBuffer and typed arrays. */
export function structuredCloneFallback<T>(value: T, seen = new Map<unknown, unknown>()): T {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "function" || typeof value === "symbol") throw new TypeError("value could not be cloned");
    return value;
  }
  if (seen.has(value)) return seen.get(value) as T;
  let out: any;
  if (value instanceof Date) out = new Date(value.getTime());
  else if (value instanceof ArrayBuffer) out = value.slice(0);
  else if (ArrayBuffer.isView(value)) {
    const v = value as unknown as {
      constructor: new (b: ArrayBuffer) => unknown;
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
      slice?: () => unknown;
    };
    out =
      typeof v.slice === "function"
        ? v.slice()
        : new v.constructor(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  } else if (value instanceof Map) {
    out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(structuredCloneFallback(k, seen), structuredCloneFallback(v, seen));
    return out;
  } else if (value instanceof Set) {
    out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(structuredCloneFallback(v, seen));
    return out;
  } else if (Array.isArray(value)) {
    out = new Array(value.length);
    seen.set(value, out);
    value.forEach((v, i) => (out[i] = structuredCloneFallback(v, seen)));
    return out;
  } else {
    out = {};
    seen.set(value, out);
    for (const k of Object.keys(value)) out[k] = structuredCloneFallback((value as any)[k], seen);
    return out;
  }
  seen.set(value, out);
  return out;
}

export class AggregateErrorFallback extends Error {
  readonly errors: unknown[];
  constructor(errors: Iterable<unknown>, message = "All promises were rejected") {
    super(message);
    this.name = "AggregateError";
    this.errors = [...errors];
  }
}

export function promiseAnyFallback<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>> {
  const items = [...values];
  const AE: new (e: unknown[], m?: string) => Error = g.AggregateError ?? AggregateErrorFallback;
  return new Promise((resolve, reject) => {
    if (items.length === 0) {
      reject(new AE([], "All promises were rejected"));
      return;
    }
    const errors: unknown[] = new Array(items.length);
    let pending = items.length;
    items.forEach((item, i) =>
      Promise.resolve(item).then(
        (v) => resolve(v as Awaited<T>),
        (e) => {
          errors[i] = e;
          if (--pending === 0) reject(new AE(errors, "All promises were rejected"));
        },
      ),
    );
  });
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function btoaFallback(input: string): string {
  const s = String(input);
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = s.charCodeAt(i + 1);
    const c = s.charCodeAt(i + 2);
    if (a > 255 || (b > 255 && !Number.isNaN(b)) || (c > 255 && !Number.isNaN(c)))
      throw new Error("btoa: string contains characters outside of the Latin1 range");
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += Number.isNaN(b) ? "=" : B64[(n >> 6) & 63]!;
    out += Number.isNaN(c) ? "=" : B64[n & 63]!;
  }
  return out;
}

export function atobFallback(input: string): string {
  const s = String(input).replace(/[\t\n\f\r ]+/g, "");
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(s) || /=[^=]/.test(s)) throw new Error("atob: invalid base64");
  let out = "";
  let bits = 0;
  let value = 0;
  for (const ch of s.replace(/=+$/, "")) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

/** Install every missing global. Safe to call more than once. */
export function installLanguagePolyfills(target: Record<string, any> = g): void {
  if (typeof target.TextEncoder === "undefined") target.TextEncoder = Utf8TextEncoder;
  if (typeof target.TextDecoder === "undefined") target.TextDecoder = Utf8TextDecoder;
  if (typeof target.structuredClone === "undefined")
    target.structuredClone = (v: unknown) => structuredCloneFallback(v);
  if (typeof target.AggregateError === "undefined") target.AggregateError = AggregateErrorFallback;
  const P = (target.Promise ?? Promise) as { any?: unknown };
  if (typeof P.any !== "function") P.any = promiseAnyFallback;
  if (typeof target.btoa === "undefined") target.btoa = btoaFallback;
  if (typeof target.atob === "undefined") target.atob = atobFallback;
}
