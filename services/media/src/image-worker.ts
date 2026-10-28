/*
 * Runs inside a worker thread (see image.ts): every decode of untrusted image bytes by libvips happens here,
 * under a heap limit and a wall-clock limit enforced by the parent, so a hostile file cannot stall or
 * crash the caller's event loop. Self-contained on purpose: it imports only packages and `import type`,
 * so Node can run it from source (type stripping) as well as from dist.
 */
import { encode } from "blurhash";
import sharp from "sharp";
import { parentPort, workerData } from "node:worker_threads";
import type { EncodedImage, ImageJob, ImageJobResult } from "./image-types.js";

sharp.cache(false);
sharp.concurrency(1);

const BLURHASH_SIDE = 32;
const WEBP_QUALITY = 80;

async function run(job: ImageJob): Promise<ImageJobResult> {
  const input = { limitInputPixels: job.maxPixels, failOn: "error" as const };
  const meta = await sharp(job.bytes, input).metadata();
  if (!meta.width || !meta.height) throw new Error("image has no dimensions");
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;

  // Variants at each requested width the image reaches (never upscaled); a smaller image still gets one
  // WebP, at its own size, under the smallest key.
  let targets = job.widths.filter((w) => w <= width).map((w) => ({ key: w, width: w }));
  if (targets.length === 0) targets = [{ key: Math.min(...job.widths), width }];
  const variants: ImageJobResult["variants"] = [];
  for (const t of targets) {
    const { data, info } = await sharp(job.bytes, input)
      .rotate()
      .resize({ width: t.width, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    variants.push({ key: t.key, image: { bytes: new Uint8Array(data), width: info.width, height: info.height } });
  }

  const raw = await sharp(job.bytes, input)
    .rotate()
    .resize(BLURHASH_SIDE, BLURHASH_SIDE, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const landscape = raw.info.width >= raw.info.height;
  const blurhash = encode(
    new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
    raw.info.width,
    raw.info.height,
    landscape ? 4 : 3,
    landscape ? 3 : 4,
  );

  let original: EncodedImage | null = null;
  if (job.reencodeOriginalAs) {
    // sharp writes no Exif/XMP/IPTC unless asked; the ICC profile is kept for colour accuracy.
    let pipeline = sharp(job.bytes, input).rotate().keepIccProfile();
    if (job.reencodeOriginalAs === "jpeg") pipeline = pipeline.jpeg({ quality: 92, chromaSubsampling: "4:4:4" });
    else if (job.reencodeOriginalAs === "png") pipeline = pipeline.png();
    else pipeline = pipeline.webp({ quality: 92 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    original = { bytes: new Uint8Array(data), width: info.width, height: info.height };
  }
  return { width, height, variants, blurhash, original };
}

run(workerData as ImageJob).then(
  (result) => {
    const transfer = [
      ...result.variants.map((v) => v.image.bytes.buffer as ArrayBuffer),
      ...(result.original ? [result.original.bytes.buffer as ArrayBuffer] : []),
    ];
    parentPort!.postMessage({ ok: true, result }, transfer);
  },
  (e: unknown) => {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  },
);
