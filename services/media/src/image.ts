import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  detectMime,
  findMetadata,
  INFORMATIONAL_FINDINGS,
  readOrientation,
  stripMetadata,
} from "@azaadawaaz/media-strip";
import { MediaInputError, resolveLimits, type MediaLimits } from "./config.js";
import type { EncodedImage, ImageFormat, ImageJob, ImageJobResult } from "./image-types.js";

/** Variant widths (spec §4.1). */
export const IMAGE_WIDTHS = [480, 960, 1600] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export interface ImageVariant {
  bytes: Uint8Array;
  sha256: string;
  width: number;
  height: number;
}

export interface ProcessedImage {
  /** The original, metadata-free (re-checked with media-strip), with dimensions after Exif orientation. */
  original: { bytes: Uint8Array; sha256: string; mime: string; width: number; height: number };
  /** WebP variants, never upscaled; an image narrower than 480 px gets only "480" at its own width. */
  variants: Partial<Record<`${ImageWidth}`, ImageVariant>>;
  blurhash: string;
}

const FORMATS: Record<string, ImageFormat> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isClean(bytes: Uint8Array, mime: string): boolean {
  return findMetadata(bytes, mime).every((f) => INFORMATIONAL_FINDINGS.includes(f));
}

/** The worker file next to this module: `.ts` when running from source (tests), `.js` from dist. */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./image-worker${ext}`, import.meta.url);
}

/** Runs one image job in a fresh worker thread with a heap limit, killing it after `timeoutMs`. */
function runWorker(job: ImageJob, limits: MediaLimits): Promise<ImageJobResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), {
      workerData: job,
      transferList: [job.bytes.buffer as ArrayBuffer],
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: limits.imageWorkerHeapMb, maxYoungGenerationSizeMb: 32 },
      stdout: false,
      stderr: false,
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new MediaInputError(`image processing timed out after ${limits.imageTimeoutMs} ms`))),
      limits.imageTimeoutMs,
    );
    worker.on("message", (msg: { ok: true; result: ImageJobResult } | { ok: false; error: string }) => {
      finish(() => (msg.ok ? resolve(msg.result) : reject(new MediaInputError(`image rejected: ${msg.error}`))));
    });
    worker.on("error", (e) => finish(() => reject(new MediaInputError(`image worker failed: ${e.message}`))));
    worker.on("exit", (code) => finish(() => reject(new MediaInputError(`image worker exited (${code})`))));
  });
}

/**
 * Server-side image processing (spec §4.1, architecture "Media processing"): WebP variants at 480/960/1600
 * px wide (never upscaled), a blurhash, and the original after re-checking it with media-strip. JPEG, PNG
 * and WebP only (the contributor's device converts anything else to JPEG before upload). All decoding
 * happens in a worker thread with a time and heap limit.
 *
 * The original is passed through untouched when it is already clean. Otherwise it is stripped again
 * losslessly, unless it still carries an Exif orientation other than 1: stripping would drop the rotation,
 * so it is re-encoded with the rotation applied instead (in its own format, ICC profile kept).
 */
export async function processImage(
  bytes: Uint8Array,
  opts: { limits?: Partial<MediaLimits> } = {},
): Promise<ProcessedImage> {
  const limits = resolveLimits(opts.limits);
  if (bytes.length === 0) throw new MediaInputError("empty image");
  if (bytes.length > limits.maxImageBytes) {
    throw new MediaInputError(`image is ${bytes.length} bytes; the limit is ${limits.maxImageBytes}`);
  }
  const mime = detectMime(bytes);
  const format = mime ? FORMATS[mime] : undefined;
  if (!mime || !format) throw new MediaInputError(`unsupported image type: ${mime ?? "unknown"}`);

  let clean: boolean;
  let orientation: number;
  try {
    clean = isClean(bytes, mime);
    orientation = readOrientation(bytes, mime);
  } catch (e) {
    throw new MediaInputError(`image rejected: ${e instanceof Error ? e.message : String(e)}`);
  }
  const reencode = !clean && orientation !== 1;
  const job: ImageJob = {
    bytes: bytes.slice(),
    widths: [...IMAGE_WIDTHS],
    maxPixels: limits.maxImagePixels,
    reencodeOriginalAs: reencode ? format : null,
  };
  const result = await runWorker(job, limits);

  let original: Uint8Array;
  if (clean) original = bytes;
  else if (reencode) original = (result.original as EncodedImage).bytes;
  else original = stripMetadata(bytes, mime);
  if (!isClean(original, mime)) {
    throw new MediaInputError(`metadata left in original after stripping: ${findMetadata(original, mime).join(", ")}`);
  }

  const variants: ProcessedImage["variants"] = {};
  for (const v of result.variants) {
    const key = String(v.key) as `${ImageWidth}`;
    if (!isClean(v.image.bytes, "image/webp")) throw new MediaInputError(`metadata left in the ${key} variant`);
    variants[key] = {
      bytes: v.image.bytes,
      sha256: sha256Hex(v.image.bytes),
      width: v.image.width,
      height: v.image.height,
    };
  }
  return {
    original: { bytes: original, sha256: sha256Hex(original), mime, width: result.width, height: result.height },
    variants,
    blurhash: result.blurhash,
  };
}
