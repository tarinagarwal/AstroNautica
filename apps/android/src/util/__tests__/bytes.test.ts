import { base64ToBytes, bytesEqual, bytesToBase64, concatBytes } from "../bytes";
import { rgbaToBmp, blurhashDataUri } from "../blurhashImage";

describe("base64", () => {
  it("matches Node for every length and both alphabets", () => {
    for (let n = 0; n < 70; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(bytesToBase64(b)).toBe(Buffer.from(b).toString("base64"));
      expect(bytesToBase64(b, true)).toBe(Buffer.from(b).toString("base64url"));
      expect(base64ToBytes(Buffer.from(b).toString("base64"))).toEqual(b);
      expect(base64ToBytes(Buffer.from(b).toString("base64url"))).toEqual(b);
    }
    const big = Uint8Array.from({ length: 300_001 }, (_, i) => i & 255);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
    expect(() => base64ToBytes("a")).toThrow();
    expect(() => base64ToBytes("ab$d")).toThrow();
  });

  it("concatenates and compares", () => {
    expect(concatBytes([Uint8Array.from([1]), Uint8Array.from([2, 3])])).toEqual(Uint8Array.from([1, 2, 3]));
    expect(bytesEqual(Uint8Array.from([1]), Uint8Array.from([1]))).toBe(true);
    expect(bytesEqual(Uint8Array.from([1]), Uint8Array.from([2]))).toBe(false);
  });
});

describe("blurhash placeholder", () => {
  it("writes a valid top-down 24-bit BMP", () => {
    const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const bmp = rgbaToBmp(rgba, 3, 1);
    const dv = new DataView(bmp.buffer);
    expect(String.fromCharCode(bmp[0]!, bmp[1]!)).toBe("BM");
    expect(dv.getUint32(2, true)).toBe(bmp.length);
    expect(dv.getInt32(22, true)).toBe(-1);
    expect([...bmp.slice(54, 63)]).toEqual([0, 0, 255, 0, 255, 0, 255, 0, 0]);
    expect(bmp.length).toBe(54 + 12);
  });

  it("decodes hashes to data URIs and rejects invalid ones", () => {
    expect(blurhashDataUri("LEHV6nWB2yk8pyo0adR*.7kCMdnj")).toMatch(/^data:image\/bmp;base64,Qk/);
    expect(blurhashDataUri("nope")).toBeUndefined();
  });
});
