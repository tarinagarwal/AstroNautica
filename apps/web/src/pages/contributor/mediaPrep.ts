/**
 * On-device metadata removal before anything is encrypted or uploaded (spec §1.1 principle 3, §4.1):
 * `@azaadawaaz/media-strip` removes Exif/XMP/IPTC and video location atoms losslessly. Photos (JPEG, WebP, and
 * formats it can't process such as HEIC/AVIF/GIF) are always redrawn on a canvas and re-encoded as JPEG first: a camera's
 * quantization tables and encoder layout identify its make and model even with all metadata gone (security review #12,
 * spec §4.1). PNG (screenshots, graphics) stays lossless. The output is re-read and only accepted when nothing
 * identifying is left.
 */
import {
  INFORMATIONAL_FINDINGS,
  UnsupportedFormatError,
  detectMime,
  findMetadata,
  readOrientation,
  stripMetadata,
} from "@azaadawaaz/media-strip";
import { sha256Hex } from "@azaadawaaz/schema";

export interface PreparedMedia {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
  kind: "image" | "video";
  /** Metadata found in the original file (for the contributor's information). */
  removed: string[];
}

export class MediaRejectedError extends Error {
  constructor(
    readonly reason: "unsupported" | "metadata-left" | "too-large" | "decode",
    readonly detail: string[] = [],
  ) {
    super(reason);
    this.name = "MediaRejectedError";
  }
}

const identifying = (found: string[]) => found.filter((f) => !INFORMATIONAL_FINDINGS.includes(f));

/** Draw an image to a canvas (applying its orientation) and export JPEG; the browser decodes HEIC where it can. */
export async function canvasToJpeg(blob: Blob, quality = 0.92): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new MediaRejectedError("decode");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new MediaRejectedError("decode");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!out) throw new MediaRejectedError("decode");
  return new Uint8Array(await out.arrayBuffer());
}

/** SHA-256 with WebCrypto where available (much faster for large videos), else pure JS. */
export async function sha256Of(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256Hex(bytes);
}

function safeOrientation(b: Uint8Array, mime: string): number {
  try {
    return readOrientation(b, mime);
  } catch {
    return 1;
  }
}

export async function prepareMedia(
  file: Blob,
  limits: { maxImageBytes: number; maxVideoBytes: number },
  toJpeg: (b: Blob) => Promise<Uint8Array> = canvasToJpeg,
): Promise<PreparedMedia> {
  const original = new Uint8Array(await file.arrayBuffer());
  const sniffed = detectMime(original) ?? file.type ?? "";
  const isVideo = sniffed.startsWith("video/") || sniffed === "audio/mp4";
  const isImage = sniffed.startsWith("image/") || (!isVideo && file.type.startsWith("image/"));
  if (!isVideo && !isImage) throw new MediaRejectedError("unsupported", [sniffed || file.type]);
  if (original.length > (isVideo ? limits.maxVideoBytes : limits.maxImageBytes))
    throw new MediaRejectedError("too-large");

  let input: Uint8Array = original;
  let removed: string[] = [];
  try {
    removed = identifying(findMetadata(original, sniffed));
  } catch (e) {
    if (!(e instanceof UnsupportedFormatError)) throw new MediaRejectedError("unsupported", [String(e)]);
  }

  // Every image except PNG is redrawn as JPEG first: this applies orientation, decodes HEIC/AVIF/GIF where the
  // browser can, and replaces camera-specific compression with the browser's own encoder.
  const keepPng = sniffed === "image/png" && safeOrientation(original, sniffed) === 1;
  if (isImage && !keepPng) {
    input = await toJpeg(file);
  }

  let out: Uint8Array;
  try {
    out = stripMetadata(input, detectMime(input) ?? sniffed);
  } catch (e) {
    if (e instanceof UnsupportedFormatError) throw new MediaRejectedError("unsupported", [sniffed]);
    throw new MediaRejectedError("decode", [e instanceof Error ? e.message : String(e)]);
  }
  const mime = detectMime(out) ?? sniffed;
  // Re-read the output: only accept it when nothing identifying is left.
  const left = identifying(findMetadata(out, mime));
  if (left.length) throw new MediaRejectedError("metadata-left", left);
  if (out.length > (isVideo ? limits.maxVideoBytes : limits.maxImageBytes)) throw new MediaRejectedError("too-large");
  return { bytes: out, mime, sha256: await sha256Of(out), kind: isVideo ? "video" : "image", removed };
}
