import { ascii, startsWith, u32be } from "./bytes.js";

/** MIME types `detectMime` can report. Only the first group can be stripped. */
export type DetectedMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "video/mp4"
  | "video/quicktime"
  | "video/3gpp"
  | "audio/mp4"
  | "image/heic"
  | "image/heif"
  | "image/avif"
  | "image/gif"
  | "image/tiff"
  | "image/bmp";

/** MIME types `stripMetadata` handles. */
export const STRIPPABLE_MIMES: readonly DetectedMime[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/3gpp",
  "audio/mp4",
];

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "mif2", "miaf"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
/** Top-level box types that start a QuickTime file written without an `ftyp` box (old cameras, QuickTime 6). */
const QT_FIRST_BOXES = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

function isoMime(bytes: Uint8Array): DetectedMime | null {
  if (bytes.length < 12) return null;
  const firstType = ascii(bytes, 4, 8);
  if (firstType !== "ftyp") return QT_FIRST_BOXES.has(firstType) ? "video/quicktime" : null;
  const size = u32be(bytes, 0);
  const end = Math.min(size >= 16 ? size : 16, bytes.length);
  const major = ascii(bytes, 8, 12);
  const brands = [major];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(bytes, o, o + 4));
  // Image brands win over generic ones: an HEIC file may list "mp41"-style brands too.
  if (AVIF_BRANDS.has(major)) return "image/avif";
  if (HEIC_BRANDS.has(major)) return "image/heic";
  if (HEIF_BRANDS.has(major)) {
    if (brands.some((b) => AVIF_BRANDS.has(b))) return "image/avif";
    if (brands.some((b) => HEIC_BRANDS.has(b))) return "image/heic";
    return "image/heif";
  }
  if (major === "qt  ") return "video/quicktime";
  if (major.startsWith("3gp") || major.startsWith("3g2")) return "video/3gpp";
  if (major === "M4A " || major === "M4B ") return "audio/mp4";
  if (brands.some((b) => AVIF_BRANDS.has(b)) && !brands.some(isVideoBrand)) return "image/avif";
  if (brands.some((b) => HEIC_BRANDS.has(b)) && !brands.some(isVideoBrand)) return "image/heic";
  return "video/mp4";
}

function isVideoBrand(b: string): boolean {
  return b === "isom" || b === "iso2" || b === "mp41" || b === "mp42" || b === "avc1" || b === "qt  ";
}

/**
 * Sniffs the format from magic bytes. Returns `null` when nothing matches.
 * Callers must prefer this over any MIME type supplied with the file.
 */
export function detectMime(bytes: Uint8Array): DetectedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    startsWith(bytes, 1, "PNG") &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes.length >= 12 && startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) return "image/webp";
  if (startsWith(bytes, 0, "GIF87a") || startsWith(bytes, 0, "GIF89a")) return "image/gif";
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a))
  )
    return "image/tiff";
  if (startsWith(bytes, 0, "BM") && bytes.length >= 26) return "image/bmp";
  return isoMime(bytes);
}

const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "video/x-m4v": "video/mp4",
  "video/m4v": "video/mp4",
  "video/mov": "video/quicktime",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heif",
};

/** Lower-cases a MIME type, drops parameters and maps common aliases (image/jpg → image/jpeg). */
export function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return ALIASES[base] ?? base;
}
