import { describe, expect, it } from "vitest";
import {
  findMetadata,
  isMetadataFree,
  MalformedMediaError,
  readJpegOrientation,
  readOrientation,
  stripMetadata,
  stripMetadataDetailed,
} from "../src/index.js";
import {
  ascii,
  buildTiff,
  cat,
  exiftool,
  fixture,
  frameHashes,
  HAS_EXIFTOOL,
  HAS_FFMPEG,
  identifyingTags,
  jpegSegments,
  segment,
} from "./helpers.js";

const isApp = (m: number): boolean => (m >= 0xe0 && m <= 0xef) || m === 0xfe;

/** Puts extra segments right after SOI of a real JPEG and appends a trailer. */
function withSegments(base: Uint8Array, segs: Uint8Array[], trailer: Uint8Array = new Uint8Array(0)): Uint8Array {
  return cat(base.subarray(0, 2), ...segs, base.subarray(2), trailer);
}

describe("JPEG", () => {
  const phone = fixture("gps.jpg");

  it("finds Exif with GPS, XMP, IPTC, ICC, a comment and a trailer in the phone sample", () => {
    expect(findMetadata(phone, "image/jpeg").sort()).toEqual(
      ["exif", "gps", "icc", "iptc", "jpeg:comment", "jpeg:trailer", "xmp"].sort(),
    );
  });

  it("strips everything but the ICC profile by default, and the ICC profile on request", () => {
    const out = stripMetadata(phone, "image/jpeg");
    expect(findMetadata(out, "image/jpeg")).toEqual(["icc"]);
    expect(isMetadataFree(out)).toBe(true);
    const bare = stripMetadata(phone, "image/jpeg", { keepIcc: false });
    expect(findMetadata(bare, "image/jpeg")).toEqual([]);
    expect(out.length).toBeLessThan(phone.length);
  });

  it("keeps tables, frame header, scans and entropy-coded data byte for byte", () => {
    for (const name of ["gps.jpg", "progressive.jpg"]) {
      const input = fixture(name);
      const keptIn = jpegSegments(input).filter((s) => !isApp(s.marker));
      const keptOut = jpegSegments(stripMetadata(input, "image/jpeg", { keepIcc: false })).filter(
        (s) => !isApp(s.marker),
      );
      expect(keptOut.map((s) => s.marker)).toEqual(keptIn.map((s) => s.marker));
      keptOut.forEach((s, i) => expect(s.bytes).toEqual(keptIn[i]!.bytes));
    }
    // JFIF APP0 stays (first after SOI) and ICC stays when kept.
    const segs = jpegSegments(stripMetadata(phone, "image/jpeg"));
    expect(segs[1]!.marker).toBe(0xe0);
    expect(segs.filter((s) => s.marker === 0xe2)).toHaveLength(1);
  });

  it("reports the Exif orientation so the caller can rotate, and the stripped file has none", () => {
    expect(readJpegOrientation(phone)).toBe(6);
    expect(readOrientation(phone)).toBe(6);
    const detailed = stripMetadataDetailed(phone, "image/jpeg");
    expect(detailed.orientation).toBe(6);
    expect(detailed.removed).toContain("gps");
    expect(detailed.remaining).toEqual(["icc"]);
    expect(readJpegOrientation(detailed.bytes)).toBe(1);
    expect(readJpegOrientation(fixture("progressive.jpg"))).toBe(1);
  });

  it("does not modify the input and is idempotent", () => {
    const copy = phone.slice();
    const once = stripMetadata(phone, "image/jpeg");
    expect(phone).toEqual(copy);
    expect(stripMetadata(once, "image/jpeg")).toEqual(once);
  });

  it("removes extended XMP, MPF, FlashPix, JFXX, APP3–APP15, comments and the JFIF thumbnail", () => {
    const base = stripMetadata(fixture("progressive.jpg"), "image/jpeg");
    const jfifWithThumb = segment(
      0xe0,
      cat(ascii("JFIF\0"), Uint8Array.of(1, 2, 0, 0, 1, 0, 1, 2, 1), new Uint8Array(6)),
    );
    const exif = segment(0xe1, cat(ascii("Exif\0\0"), buildTiff({ orientation: 3, gps: true, littleEndian: true })));
    const xmp = segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude="28,36.8N"/>'));
    const extXmp = segment(0xe1, ascii("http://ns.adobe.com/xmp/extension/\0" + "0".repeat(40) + "<rdf/>"));
    const icc1 = segment(0xe2, cat(ascii("ICC_PROFILE\0"), Uint8Array.of(1, 2), ascii("first-half")));
    const icc2 = segment(0xe2, cat(ascii("ICC_PROFILE\0"), Uint8Array.of(2, 2), ascii("second-half")));
    const mpf = segment(0xe2, ascii("MPF\0MM\0*\0\0\0\x08"));
    const fpxr = segment(0xe2, ascii("FPXR\0\x00junk"));
    const jfxx = segment(0xe0, ascii("JFXX\0\x10thumbnail"));
    const adobe = segment(0xee, cat(ascii("Adobe"), Uint8Array.of(0, 100, 0, 0, 0, 0, 1)));
    const app15 = segment(0xef, ascii("vendor serial 1234"));
    const ducky = segment(0xec, ascii("Ducky\0\0"));
    const com = segment(0xfe, ascii("Jane's phone"));
    const iptc = segment(0xed, ascii("Photoshop 3.0\x008BIM\x04\x04"));
    const dirty = withSegments(
      base,
      [jfifWithThumb, exif, xmp, extXmp, icc1, icc2, mpf, fpxr, jfxx, adobe, app15, ducky, com, iptc],
      ascii("\xff\xd8MPF-secondary-image-with-its-own-exif"),
    );
    expect(findMetadata(dirty).sort()).toEqual(
      [
        "exif",
        "gps",
        "icc",
        "iptc",
        "jpeg:app",
        "jpeg:comment",
        "jpeg:mpf",
        "jpeg:thumbnail",
        "jpeg:trailer",
        "xmp",
      ].sort(),
    );
    expect(readJpegOrientation(dirty)).toBe(3);
    const out = stripMetadata(dirty, "image/jpeg");
    expect(findMetadata(out)).toEqual(["icc"]);
    const segs = jpegSegments(out);
    // JFIF without the thumbnail, both ICC chunks in order, the Adobe colour-transform segment, then the original
    // JFIF of the base image (one APP0 per input APP0 that was JFIF).
    expect(segs[1]!.bytes).toEqual(segment(0xe0, cat(ascii("JFIF\0"), Uint8Array.of(1, 2, 0, 0, 1, 0, 1, 0, 0))));
    expect(segs.filter((s) => s.marker === 0xe2).map((s) => s.bytes)).toEqual([icc1, icc2]);
    expect(segs.filter((s) => s.marker === 0xee).map((s) => s.bytes)).toEqual([adobe]);
    expect(segs.some((s) => [0xe1, 0xec, 0xed, 0xef, 0xfe].includes(s.marker))).toBe(false);
    expect(out.subarray(out.length - 2)).toEqual(Uint8Array.of(0xff, 0xd9));
    expect(stripMetadata(dirty, "image/jpeg", { keepIcc: false })).toEqual(
      stripMetadata(withSegments(base, [jfifWithThumb, adobe]), "image/jpeg"),
    );
  });

  it("walks restart markers, stuffed bytes and fill bytes in entropy-coded data", () => {
    const sof = segment(0xc0, Uint8Array.of(8, 0, 8, 0, 8, 1, 1, 0x11, 0));
    const sos = segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0));
    const entropy = Uint8Array.of(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd1, 0x78);
    const synthetic = cat(
      Uint8Array.of(0xff, 0xd8),
      segment(0xe1, cat(ascii("Exif\0\0"), buildTiff({ orientation: 8 }))),
      segment(0xdd, Uint8Array.of(0, 1)),
      sof,
      sos,
      entropy,
      Uint8Array.of(0xff, 0xff, 0xff, 0xd9),
    );
    expect(findMetadata(synthetic)).toEqual(["exif"]);
    expect(readJpegOrientation(synthetic)).toBe(8);
    expect(stripMetadata(synthetic, "image/jpeg")).toEqual(
      cat(Uint8Array.of(0xff, 0xd8), segment(0xdd, Uint8Array.of(0, 1)), sof, sos, entropy, Uint8Array.of(0xff, 0xd9)),
    );
  });

  it("refuses structurally broken files instead of guessing", () => {
    const truncated = phone.subarray(0, 30); // inside the Exif segment
    expect(() => stripMetadata(truncated, "image/jpeg")).toThrow(MalformedMediaError);
    const noScan = cat(Uint8Array.of(0xff, 0xd8), segment(0xe1, ascii("Exif\0\0")), Uint8Array.of(0xff, 0xd9));
    expect(() => stripMetadata(noScan, "image/jpeg")).toThrow(MalformedMediaError);
  });

  it.skipIf(!HAS_FFMPEG)("still decodes to identical pixels (ffmpeg)", () => {
    for (const name of ["gps.jpg", "progressive.jpg"]) {
      const input = fixture(name);
      const out = stripMetadata(input, "image/jpeg");
      expect(frameHashes(out, ".jpg", ["-noautorotate"])).toEqual(frameHashes(input, ".jpg", ["-noautorotate"]));
    }
  });

  it.skipIf(!HAS_EXIFTOOL)("leaves no GPS, device, time, author or IPTC tags (exiftool)", () => {
    const before = identifyingTags(exiftool(phone, ".jpg"));
    expect(before.some((t) => t.startsWith("GPS:GPSLatitude="))).toBe(true);
    expect(before.some((t) => t.startsWith("IFD0:Model=SM-G991B"))).toBe(true);
    expect(before.some((t) => t.startsWith("IPTC:City="))).toBe(true);
    const after = exiftool(stripMetadata(phone, "image/jpeg"), ".jpg");
    expect(identifyingTags(after)).toEqual([]);
    expect(after["ExifTool:Warning"]).toBeUndefined();
  });
});
