import {
  AggregateErrorFallback,
  Utf8TextDecoder,
  Utf8TextEncoder,
  atobFallback,
  btoaFallback,
  installLanguagePolyfills,
  promiseAnyFallback,
  structuredCloneFallback,
} from "../lang";

const samples = ["", "hello", "नमस्ते दुनिया", "emoji 🙏⭐ mix", "\u0000\u007f\u0080߿ࠀ￿", "a😀b"];

describe("UTF-8 codecs (Hermes polyfill)", () => {
  it("encode like Node's TextEncoder", () => {
    for (const s of samples) expect(new Utf8TextEncoder().encode(s)).toEqual(new TextEncoder().encode(s));
    expect(new Utf8TextEncoder().encode("\ud800x")).toEqual(new TextEncoder().encode("\ud800x"));
  });

  it("decode like Node's TextDecoder, including invalid input", () => {
    for (const s of samples) expect(new Utf8TextDecoder().decode(new TextEncoder().encode(s))).toBe(s);
    for (const bad of [
      [0xff],
      [0xc0, 0x80],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0x61, 0x80, 0x62],
    ]) {
      const b = Uint8Array.from(bad);
      expect(new Utf8TextDecoder().decode(b)).toBe(new TextDecoder().decode(b));
    }
    expect(() => new Utf8TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([0xff]))).toThrow();
    expect(new Utf8TextDecoder().decode(new Uint8Array(100_000).fill(0x61))).toHaveLength(100_000);
  });
});

describe("structuredClone fallback", () => {
  it("deep-clones manifests and typed arrays", () => {
    const v = {
      a: [1, { b: "x" }],
      d: new Date(5),
      u: Uint8Array.from([1, 2]),
      m: new Map([["k", { z: 1 }]]),
      s: new Set([1]),
    };
    const c = structuredCloneFallback(v);
    expect(c).toEqual(v);
    expect(c.a[1]).not.toBe(v.a[1]);
    expect(c.u).not.toBe(v.u);
    expect(() => structuredCloneFallback({ f: () => 1 })).toThrow();
  });
});

describe("Promise.any fallback", () => {
  it("resolves with the first success and aggregates failures", async () => {
    await expect(promiseAnyFallback([Promise.reject(1), Promise.resolve(2)])).resolves.toBe(2);
    await expect(promiseAnyFallback([Promise.reject(1), Promise.reject(2)])).rejects.toHaveProperty("errors", [1, 2]);
    await expect(promiseAnyFallback([])).rejects.toBeInstanceOf(Error);
    expect(new AggregateErrorFallback([1]).errors).toEqual([1]);
  });
});

describe("base64 fallbacks", () => {
  it("match atob/btoa", () => {
    for (const s of ["", "f", "fo", "foo", "foob", "ÿ\u0000x"]) {
      expect(btoaFallback(s)).toBe(btoa(s));
      expect(atobFallback(btoa(s))).toBe(s);
    }
    expect(() => btoaFallback("ह")).toThrow();
    expect(() => atobFallback("a")).toThrow();
  });

  it("installs only what is missing", () => {
    const target: Record<string, any> = { Promise: { any: undefined } };
    installLanguagePolyfills(target);
    expect(typeof target.TextDecoder).toBe("function");
    expect(typeof target.structuredClone).toBe("function");
    expect(typeof target.Promise.any).toBe("function");
    const existing = {
      TextDecoder: 1,
      TextEncoder: 2,
      structuredClone: 3,
      atob: 4,
      btoa: 5,
      AggregateError: 6,
      Promise,
    };
    installLanguagePolyfills(existing);
    expect(existing.TextDecoder).toBe(1);
  });
});
