import { describe, expect, it } from "vitest";
import { detectMime, findMetadata, normalizeMime, stripMetadata, UnsupportedFormatError } from "../src/index.js";
import { ascii, cat, fixture, u32 } from "./helpers.js";

function ftyp(major: string, ...compatible: string[]): Uint8Array {
  const body = cat(ascii(major), u32(0), ...compatible.map(ascii));
  return cat(u32(body.length + 8), ascii("ftyp"), body, u32(8), ascii("mdat"));
}

describe("detectMime", () => {
  it.each([
    ["gps.jpg", "image/jpeg"],
    ["progressive.jpg", "image/jpeg"],
    ["gps.png", "image/png"],
    ["gps.webp", "image/webp"],
    ["phone.mp4", "video/mp4"],
    ["phone-moovlast.mp4", "video/mp4"],
    ["fragmented.mp4", "video/mp4"],
    ["phone.mov", "video/quicktime"],
    ["sample.avif", "image/avif"],
  ])("sniffs %s as %s", (name, mime) => {
    expect(detectMime(fixture(name))).toBe(mime);
  });

  it("recognises HEIC/HEIF brands and QuickTime files without ftyp", () => {
    expect(detectMime(ftyp("heic", "mif1", "heic"))).toBe("image/heic");
    expect(detectMime(ftyp("mif1", "mif1", "heic"))).toBe("image/heic");
    expect(detectMime(ftyp("mif1", "mif1"))).toBe("image/heif");
    expect(detectMime(ftyp("3gp5", "3gp5", "isom"))).toBe("video/3gpp");
    expect(detectMime(ftyp("M4A ", "M4A ", "mp42"))).toBe("audio/mp4");
    expect(detectMime(cat(u32(8), ascii("wide"), u32(8), ascii("mdat")))).toBe("video/quicktime");
    expect(detectMime(ascii("GIF89a\x01\x00\x01\x00"))).toBe("image/gif");
    expect(detectMime(ascii("not a media file at all"))).toBeNull();
    expect(detectMime(new Uint8Array(0))).toBeNull();
  });

  it("normalises declared MIME types", () => {
    expect(normalizeMime("image/JPG; q=1")).toBe("image/jpeg");
    expect(normalizeMime(undefined)).toBeNull();
  });

  it("trusts the sniffed format over the declared one", () => {
    const jpeg = fixture("gps.jpg");
    expect(stripMetadata(jpeg, "video/mp4")).toEqual(stripMetadata(jpeg, "image/jpeg"));
    expect(findMetadata(fixture("phone.mp4"), "image/png")).toContain("mp4:location");
    // A HEIC renamed to .jpg is still refused.
    expect(() => stripMetadata(ftyp("heic", "mif1", "heic"), "image/jpeg")).toThrow(UnsupportedFormatError);
  });

  it("refuses HEIC, HEIF, AVIF, GIF and unknown bytes with UnsupportedFormatError", () => {
    for (const bytes of [
      ftyp("heic", "heic"),
      ftyp("mif1"),
      fixture("sample.avif"),
      ascii("GIF89a\0\0\0\0"),
      ascii("xx"),
    ]) {
      expect(() => stripMetadata(bytes, "image/jpeg")).toThrow(UnsupportedFormatError);
      expect(() => findMetadata(bytes)).toThrow(UnsupportedFormatError);
    }
    try {
      stripMetadata(fixture("sample.avif"), "image/avif");
    } catch (e) {
      expect((e as UnsupportedFormatError).mime).toBe("image/avif");
    }
  });
});
