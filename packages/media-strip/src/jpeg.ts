import { concat, indexOfAscii, startsWith, u16be } from "./bytes.js";
import { MalformedMediaError } from "./errors.js";
import { readTiff } from "./exif.js";

interface Segment {
  /** Marker byte after 0xFF (e.g. 0xE1 for APP1). 0 for entropy-coded data. */
  marker: number;
  /** Offset of the 0xFF that starts the marker (or of the first entropy byte). */
  start: number;
  /** Offset just past the segment. */
  end: number;
  /** Offset of the payload (after the 2-byte length) for segments with a length. */
  payload: number;
}

interface ParsedJpeg {
  segments: Segment[];
  /** Offset where bytes after EOI begin (equal to length when there is no trailer). */
  trailerStart: number;
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const APP14 = 0xee;

function isStandalone(m: number): boolean {
  return (m >= 0xd0 && m <= 0xd7) || m === 0x01;
}

function isSof(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function parse(b: Uint8Array): ParsedJpeg {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) throw new MalformedMediaError("JPEG: missing SOI");
  const segments: Segment[] = [{ marker: SOI, start: 0, end: 2, payload: 2 }];
  let pos = 2;
  let sawSof = false;
  let sawSos = false;
  let trailerStart = b.length;
  while (pos < b.length) {
    if (b[pos] !== 0xff) {
      // Junk between segments (decoders skip it with a warning). We skip it too, which also drops it.
      pos++;
      continue;
    }
    while (pos + 1 < b.length && b[pos + 1] === 0xff) pos++; // fill bytes
    if (pos + 1 >= b.length) break;
    const marker = b[pos + 1]!;
    if (marker === 0x00) {
      pos += 2;
      continue;
    }
    if (marker === SOI) throw new MalformedMediaError("JPEG: unexpected SOI inside image");
    if (marker === EOI) {
      segments.push({ marker, start: pos, end: pos + 2, payload: pos + 2 });
      trailerStart = pos + 2;
      break;
    }
    if (isStandalone(marker)) {
      segments.push({ marker, start: pos, end: pos + 2, payload: pos + 2 });
      pos += 2;
      continue;
    }
    if (pos + 4 > b.length) throw new MalformedMediaError("JPEG: truncated segment header");
    const len = u16be(b, pos + 2);
    const end = pos + 2 + len;
    if (len < 2 || end > b.length)
      throw new MalformedMediaError(`JPEG: segment 0x${marker.toString(16)} overruns file`);
    segments.push({ marker, start: pos, end, payload: pos + 4 });
    if (isSof(marker)) sawSof = true;
    pos = end;
    if (marker === SOS) {
      sawSos = true;
      let i = pos;
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length) {
          const n = b[i + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      if (i > pos) segments.push({ marker: 0, start: pos, end: i, payload: pos });
      pos = i;
    }
  }
  if (!sawSof || !sawSos) throw new MalformedMediaError("JPEG: no frame or scan found");
  return { segments, trailerStart };
}

function isJfif(b: Uint8Array, s: Segment): boolean {
  return s.marker === APP0 && startsWith(b, s.payload, "JFIF") && b[s.payload + 4] === 0;
}

function isIcc(b: Uint8Array, s: Segment): boolean {
  return s.marker === APP2 && startsWith(b, s.payload, "ICC_PROFILE") && b[s.payload + 11] === 0;
}

/** The standard Adobe APP14 segment (exactly 12 payload bytes: "Adobe", version, two flag words, transform). */
function isAdobe(b: Uint8Array, s: Segment): boolean {
  return s.marker === APP14 && s.end - s.payload === 12 && startsWith(b, s.payload, "Adobe");
}

function isExif(b: Uint8Array, s: Segment): boolean {
  return s.marker === APP1 && startsWith(b, s.payload, "Exif") && b[s.payload + 4] === 0;
}

function isXmp(b: Uint8Array, s: Segment): boolean {
  return (
    s.marker === APP1 &&
    (startsWith(b, s.payload, "http://ns.adobe.com/xap/1.0/\0") ||
      startsWith(b, s.payload, "http://ns.adobe.com/xmp/extension/\0"))
  );
}

/** JFIF APP0 rewritten without its optional embedded thumbnail (which can show an uncropped original). */
function jfifWithoutThumbnail(b: Uint8Array, s: Segment): Uint8Array {
  const payloadLen = s.end - s.payload;
  if (payloadLen <= 14) return b.subarray(s.start, s.end);
  const out = new Uint8Array(2 + 2 + 14);
  out.set([0xff, APP0, 0, 16]);
  out.set(b.subarray(s.payload, s.payload + 12), 4); // "JFIF\0", version, units, densities
  out[16] = 0; // thumbnail width
  out[17] = 0; // thumbnail height
  return out;
}

export interface JpegStripOptions {
  keepIcc: boolean;
}

/**
 * Removes every metadata segment from a JPEG without touching the compressed image: kept are SOI, JFIF APP0
 * (without thumbnail), ICC APP2 (optional), the standard Adobe APP14 (needed to decode CMYK/RGB JPEGs
 * correctly), DQT/DHT/DRI/SOFn/SOS and the entropy-coded data, and EOI. Dropped are Exif and XMP (APP1,
 * including extended XMP), IPTC/Photoshop (APP13), MPF and FlashPix (APP2), all other APPn, COM, and
 * anything after EOI (MPF secondary images, vendor trailers).
 */
export function stripJpeg(b: Uint8Array, opts: JpegStripOptions): Uint8Array {
  const { segments } = parse(b);
  const parts: Uint8Array[] = [];
  for (const s of segments) {
    const m = s.marker;
    if (m === COM) continue;
    if (m >= APP0 && m <= 0xef) {
      if (isJfif(b, s)) parts.push(jfifWithoutThumbnail(b, s));
      else if (opts.keepIcc && isIcc(b, s)) parts.push(b.subarray(s.start, s.end));
      else if (isAdobe(b, s)) parts.push(b.subarray(s.start, s.end));
      continue;
    }
    parts.push(b.subarray(s.start, s.end));
  }
  return concat(parts);
}

export function findJpegMetadata(b: Uint8Array): string[] {
  const { segments, trailerStart } = parse(b);
  const found: string[] = [];
  for (const s of segments) {
    const m = s.marker;
    if (m === COM) found.push("jpeg:comment");
    else if (isExif(b, s)) {
      found.push("exif");
      if (readTiff(b.subarray(s.payload + 6, s.end)).hasGps) found.push("gps");
    } else if (isXmp(b, s)) {
      found.push("xmp");
      if (indexOfAscii(b, "GPSLatitude", s.payload, s.end) >= 0) found.push("gps");
    } else if (m === APP13) found.push("iptc");
    else if (isIcc(b, s)) found.push("icc");
    else if (m === APP2 && startsWith(b, s.payload, "MPF\0")) found.push("jpeg:mpf");
    else if (isJfif(b, s)) {
      if (s.end - s.payload > 14) found.push("jpeg:thumbnail");
    } else if (isAdobe(b, s)) {
      // Colour-transform flags only; required for correct decoding.
    } else if (m >= APP0 && m <= 0xef) found.push("jpeg:app");
  }
  if (trailerStart < b.length) found.push("jpeg:trailer");
  return found;
}

/**
 * Returns the Exif orientation (1–8) of a JPEG, or 1 when there is none. Read it BEFORE stripping: the
 * stripped file no longer carries it, so a caller showing or re-encoding the image must rotate the pixels
 * itself when this is not 1 (the web client draws it to a canvas with the matching transform).
 */
export function readJpegOrientation(b: Uint8Array): number {
  const { segments } = parse(b);
  for (const s of segments) {
    if (s.marker === SOS) break;
    if (isExif(b, s)) return readTiff(b.subarray(s.payload + 6, s.end)).orientation;
  }
  return 1;
}
