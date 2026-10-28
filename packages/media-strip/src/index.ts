/**
 * @azaadawaaz/media-strip: lossless removal of identifying metadata (GPS, device, timestamps, names) from
 * JPEG, PNG, WebP and MP4/MOV, on the contributor's device, before upload (spec §1.1 principle 3, §4.1).
 *
 * Pure TypeScript over Uint8Array/DataView: no Buffer, no fs, no native code; it runs in browsers, React
 * Native and Node. Images and videos are never re-encoded: compressed image data and media samples are
 * copied byte for byte.
 *
 * Client flow:
 *   1. `detectMime(bytes)`; if `stripMetadata` throws `UnsupportedFormatError` (HEIC/HEIF, AVIF, GIF, TIFF,
 *      BMP, unknown), draw the image to a canvas, export it as JPEG and continue with those bytes.
 *   2. For JPEG (and PNG/WebP with Exif) read `readOrientation(bytes)` first. Stripping removes the Exif
 *      orientation tag, so when it is not 1 the web client draws the image to a canvas with the matching
 *      rotation/flip, exports JPEG (a canvas export carries no metadata) and strips that.
 *      Video rotation lives in the track matrix (tkhd), which is kept, so videos need nothing extra.
 *   3. `stripMetadata(bytes, mime)`, then `isMetadataFree(result, mime)` on the OUTPUT before showing
 *      "metadata removed ✓".
 */
import { toBytes } from "./bytes.js";
import { findBmffMetadata, stripBmff } from "./bmff.js";
import { detectMime, normalizeMime, STRIPPABLE_MIMES, type DetectedMime } from "./detect.js";
import { UnsupportedFormatError } from "./errors.js";
import { findJpegMetadata, readJpegOrientation, stripJpeg } from "./jpeg.js";
import { findPngMetadata, readPngOrientation, stripPng } from "./png.js";
import { findWebpMetadata, readWebpOrientation, stripWebp } from "./webp.js";

export { detectMime, normalizeMime, STRIPPABLE_MIMES, type DetectedMime } from "./detect.js";
export { MalformedMediaError, UnsupportedFormatError } from "./errors.js";
export { readJpegOrientation } from "./jpeg.js";

export interface StripOptions {
  /**
   * Keep the ICC colour profile (JPEG APP2 ICC_PROFILE, PNG iCCP, WebP ICCP). Default true: without it
   * wide-gamut (Display P3) photos render with wrong colours. A profile describes a colour space, not a
   * person; a stock vendor profile can hint at the device brand, which is why `findMetadata` reports it as
   * the informational finding "icc".
   */
  keepIcc?: boolean;
}

/** Findings that are reported for information but are not identifying metadata. */
export const INFORMATIONAL_FINDINGS: readonly string[] = ["icc"];

type Input = Uint8Array | ArrayBuffer | ArrayBufferView;

/**
 * Picks the format to process: the sniffed one always wins over the declared one (a renamed or mislabelled
 * file must not slip through as the wrong type). Throws UnsupportedFormatError for formats this package
 * cannot process.
 */
function resolveMime(bytes: Uint8Array, declared: string | null | undefined): DetectedMime {
  const sniffed = detectMime(bytes);
  if (sniffed === null) throw new UnsupportedFormatError(normalizeMime(declared));
  if (!STRIPPABLE_MIMES.includes(sniffed)) throw new UnsupportedFormatError(sniffed);
  return sniffed;
}

/**
 * Returns a copy of the file with all identifying metadata removed. The input is never modified.
 * `mime` is the declared type; it is only a hint, the sniffed format decides (see `detectMime`).
 *
 * - JPEG: drops Exif/XMP/extended XMP (APP1), IPTC/Photoshop (APP13), APP2 except ICC_PROFILE, APP3–APP15
 *   (except the 12-byte Adobe APP14 colour-transform segment needed to decode RGB/CMYK JPEGs correctly),
 *   COM, the JFIF thumbnail and everything after EOI (MPF secondary images, vendor trailers). JFIF, DQT,
 *   DHT, DRI, SOFn, SOS and the entropy-coded data are unchanged.
 * - PNG: keeps critical chunks and the rendering chunks (tRNS, gAMA, cHRM, sRGB, iCCP, pHYs, sBIT, bKGD,
 *   cICP, mDCV, cLLI, APNG acTL/fcTL/fdAT) with their original CRCs; drops eXIf, tEXt, zTXt, iTXt, tIME,
 *   every other ancillary chunk and anything after IEND.
 * - WebP: drops EXIF, XMP and unknown chunks, clears the VP8X flags and fixes the RIFF size.
 * - MP4/MOV/3GP: see `bmff.ts`; removed boxes become zero-filled `free` boxes so no offset changes and the
 *   audio/video sample bytes in mdat stay identical.
 * - Anything else throws UnsupportedFormatError; a structurally broken file throws MalformedMediaError.
 */
export function stripMetadata(input: Input, mime?: string | null, opts: StripOptions = {}): Uint8Array {
  const bytes = toBytes(input);
  const keepIcc = opts.keepIcc ?? true;
  switch (resolveMime(bytes, mime)) {
    case "image/jpeg":
      return stripJpeg(bytes, { keepIcc });
    case "image/png":
      return stripPng(bytes, { keepIcc });
    case "image/webp":
      return stripWebp(bytes, { keepIcc });
    default:
      return stripBmff(bytes);
  }
}

/**
 * Names of the metadata present in a file, without duplicates:
 * "exif", "gps", "xmp", "iptc", "icc" (informational), "png:text", "png:time", "webp:exif", "webp:xmp",
 * "mp4:udta", "mp4:location", "mp4:meta", "mp4:uuid", "mp4:timestamps", plus the finer-grained
 * "jpeg:comment", "jpeg:app", "jpeg:mpf", "jpeg:thumbnail", "jpeg:trailer", "png:other", "png:trailer",
 * "webp:other", "webp:trailer", "mp4:data-track", "mp4:encoder", "mp4:free-data", "mp4:other",
 * "mp4:trailer". An empty array (or only informational entries) means nothing identifying is left.
 */
export function findMetadata(input: Input, mime?: string | null): string[] {
  const bytes = toBytes(input);
  let found: string[];
  switch (resolveMime(bytes, mime)) {
    case "image/jpeg":
      found = findJpegMetadata(bytes);
      break;
    case "image/png":
      found = findPngMetadata(bytes);
      break;
    case "image/webp":
      found = findWebpMetadata(bytes);
      break;
    default:
      found = findBmffMetadata(bytes);
  }
  return [...new Set(found)];
}

/** True when `findMetadata` reports nothing but informational findings. Check the stripped OUTPUT with this. */
export function isMetadataFree(input: Input, mime?: string | null): boolean {
  return findMetadata(input, mime).every((f) => INFORMATIONAL_FINDINGS.includes(f));
}

/**
 * Exif orientation (1–8) of a JPEG, PNG (eXIf) or WebP (EXIF chunk); 1 when absent or for other formats.
 * 1 = upright; 3 = rotate 180°; 6 = rotate 90° clockwise; 8 = rotate 90° counter-clockwise; 2/4/5/7 are
 * the mirrored variants. Read it before stripping and rotate the pixels when it is not 1.
 */
export function readOrientation(input: Input, mime?: string | null): number {
  const bytes = toBytes(input);
  const sniffed = detectMime(bytes) ?? normalizeMime(mime);
  if (sniffed === "image/jpeg") return readJpegOrientation(bytes);
  if (sniffed === "image/png") return readPngOrientation(bytes);
  if (sniffed === "image/webp") return readWebpOrientation(bytes);
  return 1;
}

export interface StripResult {
  bytes: Uint8Array;
  /** The sniffed format of the input (and output). */
  mime: DetectedMime;
  /** Exif orientation of the input; when not 1 the caller must rotate the pixels (see `readOrientation`). */
  orientation: number;
  /** What the input carried (`findMetadata` of the input). */
  removed: string[];
  /** What is left in the output; only informational findings (if any) when stripping worked. */
  remaining: string[];
}

/** `stripMetadata` plus the orientation, what was removed and a re-check of the output. */
export function stripMetadataDetailed(input: Input, mime?: string | null, opts: StripOptions = {}): StripResult {
  const bytes = toBytes(input);
  const resolved = resolveMime(bytes, mime);
  const orientation = readOrientation(bytes, resolved);
  const removed = findMetadata(bytes, resolved);
  const out = stripMetadata(bytes, resolved, opts);
  return { bytes: out, mime: resolved, orientation, removed, remaining: findMetadata(out, resolved) };
}
