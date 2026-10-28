import { ascii, concat, indexOfAscii, startsWith, u32le, writeU32le } from "./bytes.js";
import { MalformedMediaError } from "./errors.js";
import { readTiff, tiffFromExifPayload } from "./exif.js";

interface Chunk {
  fourcc: string;
  start: number;
  data: number;
  size: number;
  /** Offset just past the chunk including its pad byte. */
  end: number;
}

const KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);
const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

function parse(b: Uint8Array): { chunks: Chunk[]; riffEnd: number } {
  if (b.length < 20 || !startsWith(b, 0, "RIFF") || !startsWith(b, 8, "WEBP")) {
    throw new MalformedMediaError("WebP: bad RIFF header");
  }
  const riffEnd = u32le(b, 4) + 8;
  if (riffEnd > b.length || riffEnd < 20) throw new MalformedMediaError("WebP: RIFF size overruns file");
  const chunks: Chunk[] = [];
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const fourcc = ascii(b, pos, pos + 4);
    const size = u32le(b, pos + 4);
    const dataEnd = pos + 8 + size;
    if (dataEnd > riffEnd) throw new MalformedMediaError(`WebP: chunk ${fourcc} overruns file`);
    const end = Math.min(dataEnd + (size & 1), riffEnd);
    chunks.push({ fourcc, start: pos, data: pos + 8, size, end });
    pos = end;
  }
  if (!chunks.some((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L" || c.fourcc === "ANMF")) {
    throw new MalformedMediaError("WebP: no image data");
  }
  return { chunks, riffEnd };
}

/**
 * Drops the EXIF and XMP chunks, unknown chunks and bytes after the RIFF end; clears the EXIF/XMP
 * (and, when the ICC profile is dropped, ICC) flags in VP8X; rewrites the RIFF size. Image chunks are
 * copied byte for byte.
 */
export function stripWebp(b: Uint8Array, opts: { keepIcc: boolean }): Uint8Array {
  const { chunks } = parse(b);
  const keepIcc = opts.keepIcc && chunks.some((c) => c.fourcc === "ICCP");
  const parts: Uint8Array[] = [b.slice(0, 12)];
  for (const c of chunks) {
    if (c.fourcc === "VP8X") {
      const copy = b.slice(c.start, c.end);
      if (copy.length > 8) {
        let flags = copy[8]! & ~(FLAG_EXIF | FLAG_XMP);
        if (!keepIcc) flags &= ~FLAG_ICC;
        copy[8] = flags;
      }
      parts.push(copy);
    } else if (KEEP.has(c.fourcc) || (keepIcc && c.fourcc === "ICCP")) {
      parts.push(b.subarray(c.start, c.end));
    }
  }
  const out = concat(parts);
  writeU32le(out, 4, out.length - 8);
  return out;
}

export function findWebpMetadata(b: Uint8Array): string[] {
  const { chunks, riffEnd } = parse(b);
  const found: string[] = [];
  for (const c of chunks) {
    if (c.fourcc === "EXIF") {
      found.push("webp:exif");
      if (readTiff(tiffFromExifPayload(b.subarray(c.data, c.data + c.size))).hasGps) found.push("gps");
    } else if (c.fourcc === "XMP ") {
      found.push("webp:xmp");
      if (indexOfAscii(b, "GPSLatitude", c.data, c.data + c.size) >= 0) found.push("gps");
    } else if (c.fourcc === "ICCP") found.push("icc");
    else if (!KEEP.has(c.fourcc)) found.push("webp:other");
  }
  if (riffEnd < b.length) found.push("webp:trailer");
  return found;
}

/** Orientation from a WebP EXIF chunk (1 when absent). */
export function readWebpOrientation(b: Uint8Array): number {
  const { chunks } = parse(b);
  const c = chunks.find((x) => x.fourcc === "EXIF");
  return c ? readTiff(tiffFromExifPayload(b.subarray(c.data, c.data + c.size))).orientation : 1;
}
