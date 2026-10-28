import { isBlurhashValid } from "blurhash";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { detectMime, findMetadata, readOrientation, stripMetadata } from "@azaadawaaz/media-strip";
import { MediaInputError, processImage, sha256Hex } from "../src/index.js";
import { contains, stripFixture } from "./helpers.js";

async function phoneJpeg(width: number, height: number, orientation: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><circle cx="20%" cy="30%" r="15%" fill="#0a0"/></svg>`,
        ),
      },
    ])
    .withExif({
      IFD0: { Make: "Samsung", Model: "SM-G991B", Software: "G991BXXU5CVF1" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "28/1 36/1 50/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "77/1 12/1 32/1",
      },
    })
    .withMetadata({ orientation })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(buf);
}

function expectBlurhash(hash: string, landscape: boolean): void {
  expect(isBlurhashValid(hash).result).toBe(true);
  // 4×3 components for landscape, 3×4 for portrait: 4 + 2·12 characters; first char encodes the counts.
  expect(hash).toHaveLength(28);
  expect(hash[0]).toBe(landscape ? "L" : "T");
}

describe("processImage", () => {
  it("rotates by Exif orientation, strips GPS/device data and makes WebP variants that never upscale", async () => {
    const input = await phoneJpeg(2000, 1500, 6); // stored landscape, displayed portrait 1500×2000
    expect(findMetadata(input)).toEqual(expect.arrayContaining(["exif", "gps"]));
    const r = await processImage(input);
    expect(r.original.mime).toBe("image/jpeg");
    expect([r.original.width, r.original.height]).toEqual([1500, 2000]);
    // Orientation ≠ 1 and metadata present: re-encoded upright, so stripping lost nothing.
    const meta = await sharp(r.original.bytes).metadata();
    expect([meta.width, meta.height, meta.orientation ?? 1]).toEqual([1500, 2000, 1]);
    expect(findMetadata(r.original.bytes).filter((f) => f !== "icc")).toEqual([]);
    expect(readOrientation(r.original.bytes)).toBe(1);
    expect(r.original.sha256).toBe(sha256Hex(r.original.bytes));
    expect(Object.keys(r.variants).sort()).toEqual(["480", "960"]);
    expect([r.variants["480"]!.width, r.variants["480"]!.height]).toEqual([480, 640]);
    expect([r.variants["960"]!.width, r.variants["960"]!.height]).toEqual([960, 1280]);
    for (const v of Object.values(r.variants)) {
      expect(detectMime(v.bytes)).toBe("image/webp");
      expect(findMetadata(v.bytes)).toEqual([]);
      expect(v.sha256).toBe(sha256Hex(v.bytes));
      const m = await sharp(v.bytes).metadata();
      expect([m.format, m.width, m.height]).toEqual(["webp", v.width, v.height]);
    }
    for (const bytes of [r.original.bytes, ...Object.values(r.variants).map((v) => v.bytes)]) {
      for (const secret of ["Samsung", "SM-G991B", "G991B"]) expect(contains(bytes, secret)).toBe(false);
    }
    expectBlurhash(r.blurhash, false);
  });

  it("strips an upright original losslessly instead of re-encoding it", async () => {
    const input = await phoneJpeg(1700, 1000, 1);
    const r = await processImage(input);
    expect(r.original.bytes).toEqual(stripMetadata(input, "image/jpeg"));
    expect(Object.keys(r.variants).sort()).toEqual(["1600", "480", "960"]);
    expect(r.variants["1600"]!.height).toBe(941);
    expectBlurhash(r.blurhash, true);
  });

  it("passes a clean original through byte for byte and gives a small image one variant at its own size", async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 300, height: 200, channels: 4, background: "#123456" } })
        .png()
        .toBuffer(),
    );
    expect(findMetadata(png)).toEqual([]);
    const r = await processImage(png);
    expect(r.original.bytes).toEqual(png);
    expect(r.original.mime).toBe("image/png");
    expect(Object.keys(r.variants)).toEqual(["480"]);
    expect([r.variants["480"]!.width, r.variants["480"]!.height]).toEqual([300, 200]);
  });

  it("handles the on-device sample with Exif, XMP, IPTC and ICC (orientation 6)", async () => {
    const r = await processImage(stripFixture("gps.jpg"));
    expect([r.original.width, r.original.height]).toEqual([64, 96]);
    expect(findMetadata(r.original.bytes)).toEqual(["icc"]); // colour profile kept
    expect(Object.keys(r.variants)).toEqual(["480"]);
  });

  it("re-strips PNG and WebP originals", async () => {
    for (const name of ["gps.png", "gps.webp"]) {
      const input = stripFixture(name);
      const r = await processImage(input);
      expect(findMetadata(r.original.bytes).filter((f) => f !== "icc")).toEqual([]);
      expect(r.original.bytes).toEqual(stripMetadata(input));
    }
  });

  it("enforces limits and accepted formats", async () => {
    const jpeg = await phoneJpeg(400, 300, 1);
    await expect(processImage(jpeg, { limits: { maxImageBytes: 100 } })).rejects.toThrow(MediaInputError);
    await expect(processImage(jpeg, { limits: { maxImagePixels: 1000 } })).rejects.toThrow(/pixel limit|rejected/);
    await expect(processImage(jpeg, { limits: { imageTimeoutMs: 1 } })).rejects.toThrow(/timed out/);
    await expect(processImage(stripFixture("sample.avif"))).rejects.toThrow(/unsupported image type: image\/avif/);
    await expect(processImage(new TextEncoder().encode("GIF89a........"))).rejects.toThrow(MediaInputError);
    await expect(processImage(new Uint8Array(0))).rejects.toThrow(/empty/);
    const truncated = jpeg.slice(0, 600);
    await expect(processImage(truncated)).rejects.toThrow(MediaInputError);
  });
});
