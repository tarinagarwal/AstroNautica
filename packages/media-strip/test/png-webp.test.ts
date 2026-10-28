import { describe, expect, it } from "vitest";
import { findMetadata, MalformedMediaError, readOrientation, stripMetadata } from "../src/index.js";
import {
  ascii,
  buildTiff,
  cat,
  crc32,
  exiftool,
  fixture,
  frameHashes,
  HAS_EXIFTOOL,
  HAS_FFMPEG,
  identifyingTags,
  pngChunk,
  pngChunks,
  riffChunks,
  u32,
} from "./helpers.js";

describe("PNG", () => {
  const png = fixture("gps.png");

  it("finds eXIf with GPS, text chunks, XMP, tIME and ICC", () => {
    expect(findMetadata(png).sort()).toEqual(["exif", "gps", "icc", "png:text", "png:time", "xmp"].sort());
  });

  it("keeps critical and rendering chunks untouched (valid CRCs) and drops the rest", () => {
    const out = stripMetadata(png, "image/png");
    expect(findMetadata(out)).toEqual(["icc"]);
    const types = pngChunks(out).map((c) => c.type);
    expect(types[0]).toBe("IHDR");
    expect(types[types.length - 1]).toBe("IEND");
    expect(types.filter((t) => !["IHDR", "IDAT", "IEND", "iCCP", "pHYs", "gAMA", "cHRM", "sRGB"].includes(t))).toEqual(
      [],
    );
    for (const c of pngChunks(out)) expect(crc32(cat(ascii(c.type), c.data))).toBe(c.crc);
    const inputIdat = pngChunks(png).filter((c) => c.type === "IDAT");
    expect(pngChunks(out).filter((c) => c.type === "IDAT")).toEqual(inputIdat);
    expect(findMetadata(stripMetadata(png, "image/png", { keepIcc: false }))).toEqual([]);
  });

  it("drops unknown ancillary chunks (C2PA, Apple iDOT), keeps APNG and HDR chunks, cuts the trailer", () => {
    const chunks = pngChunks(png);
    const ihdr = pngChunk("IHDR", chunks[0]!.data);
    const idat = chunks.filter((c) => c.type === "IDAT").map((c) => pngChunk("IDAT", c.data));
    const exif = pngChunk("eXIf", buildTiff({ orientation: 6, gps: true }));
    const extra = [
      pngChunk("caBX", ascii("c2pa manifest with device identity")),
      pngChunk("iDOT", new Uint8Array(28)),
      pngChunk("cICP", Uint8Array.of(1, 13, 0, 1)),
      pngChunk("acTL", cat(u32(1), u32(0))),
      pngChunk("zTXt", ascii("Raw profile type exif\0\0x")),
    ];
    const dirty = cat(
      png.subarray(0, 8),
      ihdr,
      exif,
      ...extra,
      ...idat,
      pngChunk("IEND", new Uint8Array(0)),
      ascii("tail"),
    );
    expect(readOrientation(dirty)).toBe(6);
    expect(findMetadata(dirty).sort()).toEqual(["exif", "gps", "png:other", "png:text", "png:trailer"].sort());
    const out = stripMetadata(dirty, "image/png");
    expect(pngChunks(out).map((c) => c.type)).toEqual(["IHDR", "cICP", "acTL", ...idat.map(() => "IDAT"), "IEND"]);
    expect(findMetadata(out)).toEqual([]);
    expect(readOrientation(out)).toBe(1);
  });

  it("refuses broken files", () => {
    expect(() => stripMetadata(png.subarray(0, 40), "image/png")).toThrow(MalformedMediaError);
  });

  it.skipIf(!HAS_FFMPEG)("still decodes to identical pixels (ffmpeg)", () => {
    expect(frameHashes(stripMetadata(png, "image/png"), ".png")).toEqual(frameHashes(png, ".png"));
  });

  it.skipIf(!HAS_EXIFTOOL)("leaves no identifying tags (exiftool)", () => {
    expect(identifyingTags(exiftool(png, ".png")).length).toBeGreaterThan(5);
    expect(identifyingTags(exiftool(stripMetadata(png, "image/png"), ".png"))).toEqual([]);
  });
});

describe("WebP", () => {
  const webp = fixture("gps.webp");

  it("finds EXIF (with GPS), XMP and ICC", () => {
    expect(findMetadata(webp).sort()).toEqual(["gps", "icc", "webp:exif", "webp:xmp"].sort());
  });

  it("drops EXIF and XMP, clears their VP8X flags and fixes the RIFF size", () => {
    const out = stripMetadata(webp, "image/webp");
    expect(findMetadata(out)).toEqual(["icc"]);
    const chunks = riffChunks(out);
    expect(chunks.map((c) => c.fourcc)).toEqual(["VP8X", "ICCP", "VP8 "]);
    expect(chunks[0]!.data[0]! & 0x0c).toBe(0); // EXIF and XMP flags
    expect(chunks[0]!.data[0]! & 0x20).toBe(0x20); // ICC flag still set
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
    expect(chunks[2]!.data).toEqual(riffChunks(webp).find((c) => c.fourcc === "VP8 ")!.data);

    const bare = stripMetadata(webp, "image/webp", { keepIcc: false });
    expect(findMetadata(bare)).toEqual([]);
    expect(riffChunks(bare).map((c) => c.fourcc)).toEqual(["VP8X", "VP8 "]);
    expect(riffChunks(bare)[0]!.data[0]! & 0x2c).toBe(0);
  });

  it("drops unknown chunks and bytes after the RIFF end", () => {
    const inner = cat(webp, ascii("JUNK"), Uint8Array.of(4, 0, 0, 0), ascii("abcd"));
    new DataView(inner.buffer).setUint32(4, inner.length - 8, true);
    const withJunk = cat(inner, ascii("trailer"));
    expect(findMetadata(withJunk)).toEqual(expect.arrayContaining(["webp:other", "webp:trailer"]));
    expect(stripMetadata(withJunk, "image/webp")).toEqual(stripMetadata(webp, "image/webp"));
  });

  it.skipIf(!HAS_FFMPEG)("still decodes to identical pixels (ffmpeg)", () => {
    expect(frameHashes(stripMetadata(webp, "image/webp"), ".webp")).toEqual(frameHashes(webp, ".webp"));
  });

  it.skipIf(!HAS_EXIFTOOL)("leaves no identifying tags (exiftool)", () => {
    expect(identifyingTags(exiftool(webp, ".webp")).length).toBeGreaterThan(5);
    const after = exiftool(stripMetadata(webp, "image/webp"), ".webp");
    expect(identifyingTags(after)).toEqual([]);
    expect(after["ExifTool:Warning"]).toBeUndefined();
  });
});
