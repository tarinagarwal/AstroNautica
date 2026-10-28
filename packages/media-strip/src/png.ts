import { ascii, concat, indexOfAscii, startsWith, u32be } from "./bytes.js";
import { MalformedMediaError } from "./errors.js";
import { readTiff, tiffFromExifPayload } from "./exif.js";

interface Chunk {
  type: string;
  start: number;
  /** Offset of the chunk data. */
  data: number;
  /** Offset just past the CRC. */
  end: number;
}

/**
 * Ancillary chunks that affect how pixels are rendered and carry nothing about the person or device:
 * transparency, colour space and gamma, physical pixel size, significant bits, background colour,
 * HDR signalling (cICP/mDCV/cLLI) and the APNG animation chunks.
 */
const KEEP_ANCILLARY = new Set([
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "pHYs",
  "sBIT",
  "bKGD",
  "cICP",
  "mDCV",
  "cLLI",
  "acTL",
  "fcTL",
  "fdAT",
]);

function parse(b: Uint8Array): { chunks: Chunk[]; trailerStart: number } {
  if (b.length < 8 || b[0] !== 0x89 || !startsWith(b, 1, "PNG\r\n\x1a\n")) {
    throw new MalformedMediaError("PNG: bad signature");
  }
  const chunks: Chunk[] = [];
  let pos = 8;
  let trailerStart = b.length;
  while (pos < b.length) {
    if (pos + 12 > b.length) throw new MalformedMediaError("PNG: truncated chunk header");
    const len = u32be(b, pos);
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > b.length) throw new MalformedMediaError("PNG: chunk overruns file");
    const type = ascii(b, pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new MalformedMediaError("PNG: invalid chunk type");
    chunks.push({ type, start: pos, data: pos + 8, end });
    pos = end;
    if (type === "IEND") {
      trailerStart = pos;
      break;
    }
  }
  if (chunks[0]?.type !== "IHDR" || chunks[chunks.length - 1]?.type !== "IEND") {
    throw new MalformedMediaError("PNG: missing IHDR or IEND");
  }
  return { chunks, trailerStart };
}

/** Critical chunks have an upper-case first letter (IHDR, PLTE, IDAT, IEND). */
function isCritical(type: string): boolean {
  return type.charCodeAt(0) < 0x61;
}

/**
 * Keeps critical chunks, the rendering chunks in KEEP_ANCILLARY and (optionally) iCCP, untouched
 * with their original CRCs; drops eXIf, tEXt, zTXt, iTXt (XMP), tIME, every other ancillary chunk
 * (e.g. C2PA caBX, Apple iDOT, sPLT, oFFs) and anything after IEND.
 */
export function stripPng(b: Uint8Array, opts: { keepIcc: boolean }): Uint8Array {
  const { chunks } = parse(b);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  for (const c of chunks) {
    if (isCritical(c.type) || KEEP_ANCILLARY.has(c.type) || (opts.keepIcc && c.type === "iCCP")) {
      parts.push(b.subarray(c.start, c.end));
    }
  }
  return concat(parts);
}

export function findPngMetadata(b: Uint8Array): string[] {
  const { chunks, trailerStart } = parse(b);
  const found: string[] = [];
  for (const c of chunks) {
    const dataEnd = c.end - 4;
    switch (c.type) {
      case "eXIf":
        found.push("exif");
        if (readTiff(tiffFromExifPayload(b.subarray(c.data, dataEnd))).hasGps) found.push("gps");
        break;
      case "tEXt":
      case "zTXt":
      case "iTXt":
        found.push("png:text");
        if (startsWith(b, c.data, "XML:com.adobe.xmp\0")) {
          found.push("xmp");
          if (indexOfAscii(b, "GPSLatitude", c.data, dataEnd) >= 0) found.push("gps");
        }
        if (startsWith(b, c.data, "Raw profile type exif\0") || startsWith(b, c.data, "Raw profile type APP1\0")) {
          found.push("exif");
        }
        if (startsWith(b, c.data, "Raw profile type iptc\0")) found.push("iptc");
        break;
      case "tIME":
        found.push("png:time");
        break;
      case "iCCP":
        found.push("icc");
        break;
      default:
        if (!isCritical(c.type) && !KEEP_ANCILLARY.has(c.type)) found.push("png:other");
    }
  }
  if (trailerStart < b.length) found.push("png:trailer");
  return found;
}

/** Orientation from a PNG eXIf chunk (1 when absent). Browsers apply it, so read it before stripping. */
export function readPngOrientation(b: Uint8Array): number {
  const { chunks } = parse(b);
  const c = chunks.find((x) => x.type === "eXIf");
  return c ? readTiff(tiffFromExifPayload(b.subarray(c.data, c.end - 4))).orientation : 1;
}
