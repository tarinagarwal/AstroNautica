/**
 * On-device media preparation (spec §1.1.3, §4.1): everything identifying is removed before a file can be used in a
 * draft, and "metadata removed ✓" is shown only after the output was re-read and media-strip's `findMetadata`
 * returned nothing at all (the ICC profile is dropped too, so the list is truly empty).
 *
 * Images: HEIC/AVIF/GIF (and photos whose Exif orientation is not upright, since stripping removes the orientation
 * tag) are first decoded and re-encoded as JPEG natively, which writes no metadata; then media-strip strips the
 * bytes. Videos are stripped in place without re-encoding through the skeleton planner (bmffSkeleton.ts).
 */
import { detectMime, findMetadata, readJpegOrientation, stripMetadata, STRIPPABLE_MIMES } from "@azaadawaaz/media-strip";
import { sha256Hex } from "@azaadawaaz/schema";
import { joinPath, type FileSystem } from "../platform/types";
import { planVideoStrip, verifyVideoStrip, type RandomAccessFile } from "./bmffSkeleton";
import type { MediaLimits, StrippedMedia } from "./draft";

export interface MediaTools {
  /** Copy a picked content:// URI into an app file. */
  importUri(uri: string, destPath: string, maxBytes: number): Promise<{ size: number; name: string; mime: string }>;
  /** Decode (HEIC included), apply orientation, re-encode as JPEG with no metadata. */
  imageToJpeg(src: string, dest: string, quality: number): Promise<{ width: number; height: number }>;
}

export class MediaError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

const IMAGE_OUT = ["image/jpeg", "image/png", "image/webp"];
let seq = 0;
const tmpName = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function orientationOf(bytes: Uint8Array, mime: string): number {
  // Only JPEG orientation is honoured by Android decoders for the camera case; PNG/WebP Exif orientation is rare,
  // and those files are re-encoded anyway when it is set (see below).
  if (mime === "image/jpeg") return readJpegOrientation(bytes);
  return 1;
}

export async function prepareImage(
  fs: FileSystem,
  tools: MediaTools,
  uri: string,
  workDir: string,
  limits: MediaLimits,
): Promise<StrippedMedia> {
  await fs.mkdirs(workDir);
  const input = joinPath(workDir, tmpName("in"));
  const converted = joinPath(workDir, tmpName("jpg"));
  try {
    const imported = await tools.importUri(uri, input, limits.maxImageBytes * 2);
    if (imported.size === 0) throw new MediaError("media.error.empty", "the file is empty");
    let bytes = await fs.readBytes(input);
    let mime: string | null = detectMime(bytes);
    let removed: string[];
    try {
      removed = mime && STRIPPABLE_MIMES.includes(mime as never) ? findMetadata(bytes, mime) : ["original-format"];
    } catch {
      removed = ["unreadable-metadata"];
    }
    let wasConverted = false;
    if (!mime || !IMAGE_OUT.includes(mime) || orientationOf(bytes, mime) !== 1) {
      await tools.imageToJpeg(input, converted, 92);
      bytes = await fs.readBytes(converted);
      mime = detectMime(bytes);
      wasConverted = true;
      if (mime !== "image/jpeg") throw new MediaError("media.error.convert", "conversion did not produce a JPEG");
    }
    const out = stripMetadata(bytes, mime, { keepIcc: false });
    const left = findMetadata(out, mime);
    if (left.length) throw new MediaError("media.error.metadataLeft", `metadata left after stripping: ${left.join(", ")}`);
    if (out.length > limits.maxImageBytes) throw new MediaError("media.error.tooLarge", "image is too large");
    const sha256 = sha256Hex(out);
    const path = joinPath(workDir, sha256);
    await fs.writeBytes(path, out);
    // Re-read what is on disk and check it once more: this file is what gets encrypted and uploaded.
    const onDisk = await fs.readBytes(path);
    if (sha256Hex(onDisk) !== sha256 || findMetadata(onDisk, mime).length)
      throw new MediaError("media.error.metadataLeft", "stored file failed the metadata re-check");
    return { path, sha256, size: out.length, mime, removed, metadataFree: true, converted: wasConverted };
  } finally {
    await fs.remove(input).catch(() => undefined);
    await fs.remove(converted).catch(() => undefined);
  }
}

export function fileReader(fs: FileSystem, path: string, size: number): RandomAccessFile {
  return { size, read: (offset, length) => fs.readBytes(path, offset, length) };
}

export async function prepareVideo(
  fs: FileSystem,
  tools: MediaTools,
  uri: string,
  workDir: string,
  limits: MediaLimits,
): Promise<StrippedMedia> {
  await fs.mkdirs(workDir);
  const input = joinPath(workDir, tmpName("vin"));
  const output = joinPath(workDir, tmpName("vout"));
  try {
    const imported = await tools.importUri(uri, input, limits.maxVideoBytes);
    const head = await fs.readBytes(input, 0, 64);
    const sniffed = detectMime(head);
    if (sniffed !== "video/mp4" && sniffed !== "video/quicktime" && sniffed !== "video/3gpp")
      throw new MediaError("media.error.videoFormat", `unsupported video format: ${sniffed ?? "unknown"}`);
    const plan = await planVideoStrip(fileReader(fs, input, imported.size), sniffed);
    await fs.patch(
      input,
      output,
      plan.patches.map((p) => ({ offset: p.offset, data: p.data ?? new Uint8Array(0), zero: p.zero })),
      plan.truncate,
    );
    const outStat = await fs.stat(output);
    const left = await verifyVideoStrip(fileReader(fs, output, outStat.size), sniffed, plan.zeroed);
    if (left.length) throw new MediaError("media.error.metadataLeft", `metadata left after stripping: ${left.join(", ")}`);
    const sha256 = await fs.sha256(output);
    const path = joinPath(workDir, sha256);
    await fs.move(output, path);
    return {
      path,
      sha256,
      size: outStat.size,
      // The API accepts MP4 and QuickTime; 3GP is ISO BMFF like MP4 and is transcoded by the server anyway.
      mime: sniffed === "video/quicktime" ? "video/quicktime" : "video/mp4",
      removed: plan.removed,
      metadataFree: true,
    };
  } finally {
    await fs.remove(input).catch(() => undefined);
    await fs.remove(output).catch(() => undefined);
  }
}
