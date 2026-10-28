import { describe, expect, it } from "vitest";
import { findMetadata, isMetadataFree, MalformedMediaError, stripMetadata } from "../src/index.js";
import {
  ascii,
  boxes,
  cat,
  exiftool,
  ffprobe,
  findPath,
  fixture,
  frameHashes,
  HAS_EXIFTOOL,
  HAS_FFMPEG,
  identifyingTags,
  mdatBytes,
  u32,
  u64,
  upgradeTimesToV1,
} from "./helpers.js";

const VIDEOS = ["phone.mp4", "phone-moovlast.mp4", "phone.mov", "subtitled.mp4", "fragmented.mp4"] as const;
const ext = (name: string): string => name.slice(name.lastIndexOf("."));

/** Tags ffprobe may show on a clean file: container brands and per-stream language/zeroed vendor. */
const ALLOWED_FORMAT_TAGS = new Set(["major_brand", "minor_version", "compatible_brands"]);
const ALLOWED_STREAM_TAGS = new Set(["language", "vendor_id"]);

function asciiIn(haystack: Uint8Array, needle: string): boolean {
  const n = ascii(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

describe("MP4/MOV", () => {
  it.each([
    ["phone.mp4", ["mp4:udta", "mp4:location", "mp4:meta", "mp4:uuid", "xmp", "gps", "mp4:timestamps", "mp4:encoder"]],
    ["phone-moovlast.mp4", ["mp4:udta", "mp4:location", "mp4:meta", "mp4:timestamps", "mp4:encoder"]],
    ["phone.mov", ["mp4:udta", "mp4:location", "mp4:meta", "xmp", "mp4:timestamps", "mp4:data-track", "mp4:encoder"]],
    ["subtitled.mp4", ["mp4:udta", "mp4:location", "mp4:meta", "mp4:data-track", "mp4:encoder"]],
    ["fragmented.mp4", ["mp4:udta", "mp4:location", "mp4:timestamps", "mp4:data-track", "mp4:encoder"]],
  ])("finds the metadata in %s", (name, expected) => {
    expect(findMetadata(fixture(name))).toEqual(expect.arrayContaining(expected));
  });

  it.each(VIDEOS)("strips %s completely without changing its size or moving anything", (name) => {
    const input = fixture(name);
    const copy = input.slice();
    const out = stripMetadata(input, "video/mp4");
    expect(input).toEqual(copy);
    expect(out.length).toBe(input.length);
    expect(findMetadata(out)).toEqual([]);
    expect(isMetadataFree(out)).toBe(true);
    expect(stripMetadata(out, "video/mp4")).toEqual(out);
    // Top-level layout unchanged: same boxes at the same offsets (removed ones became free).
    expect(boxes(out).map((b) => [b.start, b.end])).toEqual(boxes(input).map((b) => [b.start, b.end]));
    expect(findPath(out, ["moov", "udta"])).toEqual([]);
    expect(findPath(out, ["moov", "meta"])).toEqual([]);
    expect(boxes(out).filter((b) => b.type === "uuid")).toEqual([]);
    for (const secret of ["Samsung", "SM-G991B", "iPhone", "28.6139", "Jane", "Connaught", "Lavf"]) {
      expect(asciiIn(out, secret), `${name} still contains ${secret}`).toBe(false);
    }
  });

  it.each(["phone.mp4", "phone-moovlast.mp4"])("keeps mdat byte-identical in %s", (name) => {
    const input = fixture(name);
    expect(mdatBytes(stripMetadata(input, "video/mp4"))).toEqual(mdatBytes(input));
  });

  it("changes mdat only where a dropped track's samples were (timecode, subtitles)", () => {
    for (const name of ["phone.mov", "subtitled.mp4", "fragmented.mp4"]) {
      const input = fixture(name);
      const out = stripMetadata(input, "video/mp4");
      const a = mdatBytes(input);
      const b = mdatBytes(out);
      let changed = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
      expect(changed, name).toBeGreaterThan(0);
      expect(changed, name).toBeLessThan(200); // a few short text/timecode samples, never video or audio
    }
  });

  it("handles 64-bit box sizes for mdat and moov", () => {
    const input = fixture("phone-moovlast.mp4");
    const top = boxes(input);
    const free = top.find((b) => b.type === "free")!;
    const mdat = top.find((b) => b.type === "mdat")!;
    const moov = top.find((b) => b.type === "moov")!;
    expect(free.end).toBe(mdat.start);
    expect(moov.end).toBe(input.length);
    // The 8-byte free box before mdat becomes room for mdat's 64-bit size (no offset moves); moov at the end
    // gets a 64-bit header too.
    const large = cat(
      input.subarray(0, free.start),
      u32(1),
      ascii("mdat"),
      u64(mdat.end - free.start),
      input.subarray(mdat.start + 8, mdat.end),
      u32(1),
      ascii("moov"),
      u64(moov.end - moov.start + 8),
      input.subarray(moov.start + 8, moov.end),
    );
    expect(boxes(large).map((b) => [b.type, b.header])).toEqual([
      ["ftyp", 8],
      ["mdat", 16],
      ["moov", 16],
    ]);
    expect(findMetadata(large)).toContain("mp4:location");
    const out = stripMetadata(large, "video/mp4");
    expect(findMetadata(out)).toEqual([]);
    expect(mdatBytes(out)).toEqual(mdatBytes(large));
    if (HAS_FFMPEG) expect(frameHashes(out, ".mp4")).toEqual(frameHashes(input, ".mp4"));
  });

  it("handles a last box with size 0 (extends to the end of the file)", () => {
    const input = fixture("phone.mp4");
    const mdat = boxes(input).find((b) => b.type === "mdat")!;
    expect(mdat.end).toBe(input.length);
    const zeroSized = input.slice();
    zeroSized.set(u32(0), mdat.start);
    const out = stripMetadata(zeroSized, "video/mp4");
    expect(findMetadata(out)).toEqual([]);
    expect(mdatBytes(out)).toEqual(mdatBytes(input));
    if (HAS_FFMPEG) expect(frameHashes(out, ".mp4")).toEqual(frameHashes(input, ".mp4"));
  });

  it("zeroes version-1 (64-bit) creation and modification times", () => {
    const time = 4102444800 + 2082844800; // 2100-01-01 in seconds since 1904
    const v1 = upgradeTimesToV1(fixture("phone-moovlast.mp4"), time);
    const mvhd = findPath(v1, ["moov", "mvhd"])[0]!;
    expect(v1[mvhd.start + 8]).toBe(1);
    expect(findMetadata(v1)).toContain("mp4:timestamps");
    if (HAS_FFMPEG) expect(ffprobe(v1, ".mp4").streams[0]!.tags?.creation_time).toMatch(/^2100-01-01/);
    const out = stripMetadata(v1, "video/mp4");
    expect(findMetadata(out)).toEqual([]);
    for (const path of [
      ["moov", "mvhd"],
      ["moov", "trak", "tkhd"],
      ["moov", "trak", "mdia", "mdhd"],
    ]) {
      for (const b of findPath(out, path)) {
        expect(out[b.start + 8]).toBe(1);
        expect(out.subarray(b.start + 12, b.start + 28)).toEqual(new Uint8Array(16));
      }
    }
    if (HAS_FFMPEG) {
      const probed = ffprobe(out, ".mp4");
      expect(probed.format.tags?.creation_time).toBeUndefined();
      for (const st of probed.streams) expect(st.tags?.creation_time).toBeUndefined();
      expect(frameHashes(out, ".mp4")).toEqual(frameHashes(v1, ".mp4"));
    }
  });

  it("cuts vendor trailers after the last box and removes unknown top-level boxes", () => {
    const input = fixture("phone.mp4");
    const withTrailer = cat(input, ascii("SEFH\x01\x02\x03"));
    expect(findMetadata(withTrailer)).toContain("mp4:trailer");
    expect(stripMetadata(withTrailer, "video/mp4")).toEqual(stripMetadata(input, "video/mp4"));
    const prft = cat(u32(32), ascii("prft"), new Uint8Array(24).fill(7));
    const withPrft = cat(input.subarray(0, 40), prft, input.subarray(40));
    // Inserting before moov shifts mdat, but this file is only parsed, not played.
    expect(findMetadata(withPrft)).toContain("mp4:timestamps");
    const out = stripMetadata(withPrft, "video/mp4");
    expect(out.subarray(40, 72)).toEqual(cat(u32(32), ascii("free"), new Uint8Array(24)));
  });

  it("refuses files without a usable box structure", () => {
    const input = fixture("phone.mp4");
    expect(() => stripMetadata(input.subarray(0, 100), "video/mp4")).toThrow(MalformedMediaError);
    const broken = input.slice();
    const moov = boxes(input).find((b) => b.type === "moov")!;
    broken.set(u32(0xffffff), moov.start + 8); // mvhd size far past moov
    expect(() => stripMetadata(broken, "video/mp4")).toThrow(MalformedMediaError);
  });

  it.skipIf(!HAS_FFMPEG)("plays back identically and ffprobe shows no location, device or time tags", () => {
    for (const name of VIDEOS) {
      const input = fixture(name);
      const before = ffprobe(input, ext(name));
      const out = stripMetadata(input, "video/mp4");
      const after = ffprobe(out, ext(name));
      expect(Object.keys(before.format.tags ?? {}).some((k) => k.startsWith("location") || k === "creation_time")).toBe(
        true,
      );
      for (const k of Object.keys(after.format.tags ?? {})) expect(ALLOWED_FORMAT_TAGS, `${name} ${k}`).toContain(k);
      for (const s of after.streams) {
        for (const [k, v] of Object.entries(s.tags ?? {})) {
          expect(ALLOWED_STREAM_TAGS, `${name} ${k}`).toContain(k);
          if (k === "vendor_id") expect(v).toBe("[0][0][0][0]");
        }
        expect(["video", "audio"]).toContain(s.codec_type);
      }
      const avStreams = before.streams.filter((s) => s.codec_type === "video" || s.codec_type === "audio");
      expect(after.streams).toHaveLength(avStreams.length);
      expect(frameHashes(out, ext(name)), name).toEqual(frameHashes(input, ext(name)));
    }
  });

  it.skipIf(!HAS_EXIFTOOL)("exiftool finds no GPS, make, model, dates, keys or XMP afterwards", () => {
    for (const name of VIDEOS) {
      const input = fixture(name);
      const before = identifyingTags(exiftool(input, ext(name)));
      expect(before.length, name).toBeGreaterThan(0);
      const after = exiftool(stripMetadata(input, "video/mp4"), ext(name));
      expect(identifyingTags(after), name).toEqual([]);
      expect(after["ExifTool:Warning"], name).toBeUndefined();
    }
  });
});
