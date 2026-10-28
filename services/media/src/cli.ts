#!/usr/bin/env node
/**
 * Manual runs of the media pipeline:
 *   azaad-media image <in> <outdir>   → original.<ext>, 480.webp, 960.webp, 1600.webp, image.json
 *   azaad-media video <in> <outdir>   → hls/, video.mp4, poster.jpg, preview.mp4, video.json
 * Prints the JSON summary to stdout; exits 1 on failure and 2 on bad usage.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processImage } from "./image.js";
import { processVideo } from "./video.js";

const USAGE = "usage: azaad-media image <in> <outdir>\n       azaad-media video <in> <outdir>\n";
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function image(input: string, outDir: string): Promise<unknown> {
  const result = await processImage(new Uint8Array(await readFile(input)));
  await mkdir(outDir, { recursive: true });
  const originalName = `original.${EXT[result.original.mime] ?? "bin"}`;
  await writeFile(join(outDir, originalName), result.original.bytes);
  const variants: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(result.variants)) {
    await writeFile(join(outDir, `${key}.webp`), v.bytes);
    variants[key] = { file: `${key}.webp`, sha256: v.sha256, width: v.width, height: v.height };
  }
  const { bytes: _bytes, ...original } = result.original;
  const summary = { original: { file: originalName, ...original }, variants, blurhash: result.blurhash };
  await writeFile(join(outDir, "image.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

async function video(input: string, outDir: string): Promise<unknown> {
  const result = await processVideo(input, outDir);
  await writeFile(join(outDir, "video.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, input, outDir] = argv;
  if ((cmd !== "image" && cmd !== "video") || !input || !outDir || argv.length !== 3) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const summary = cmd === "image" ? await image(input, outDir) : await video(input, outDir);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(`azaad-media: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
