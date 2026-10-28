import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findMetadata, INFORMATIONAL_FINDINGS, stripMetadata } from "@azaadawaaz/media-strip";
import { MediaInputError, resolveLimits, type MediaLimits } from "./config.js";
import { inputArgs, probeVideo, toolLimits, type VideoInfo } from "./probe.js";
import { runTool } from "./sandbox.js";

export type Rung = 360 | 720 | 1080;
export const DEFAULT_LADDER: readonly Rung[] = [360, 720, 1080];

/** One HLS rendition. `name` is its directory and the label in master.m3u8. */
export interface Rendition {
  name: string;
  /** Short side of the output frame (the "p" in 720p; for portrait video that is the width). */
  p: number;
  width: number;
  height: number;
  videoKbps: number;
}

export interface ProcessedVideo {
  /** master.m3u8 plus one directory per rendition (index.m3u8 + .ts segments), all paths relative. */
  hlsDir: string;
  mp4: { path: string; sha256: string };
  poster: { path: string; sha256: string; width: number; height: number };
  preview: { path: string; sha256: string };
  durationSec: number;
  width: number;
  height: number;
}

export interface ProcessVideoOptions {
  ladder?: Rung[];
  limits?: Partial<MediaLimits>;
}

const BITRATE_KBPS: Record<Rung, number> = { 360: 800, 720: 2800, 1080: 5000 };
const AUDIO_KBPS = 128;
const SEGMENT_SEC = 4;
const PREVIEW_SEC = 6;
const MP4_P = 720;
const PREVIEW_P = 360;

function even(x: number): number {
  return Math.max(2, Math.round(x / 2) * 2);
}

/** Output frame size for short side `p`, keeping the display aspect ratio. */
export function frameSize(width: number, height: number, p: number): { width: number; height: number } {
  if (width >= height) return { width: even((width * p) / height), height: even(p) };
  return { width: even(p), height: even((height * p) / width) };
}

/**
 * HLS ladder: the requested rungs up to the source's short side (never upscaled). A source smaller than
 * the lowest rung gets a single rendition at its own size.
 */
export function selectLadder(width: number, height: number, requested: readonly Rung[] = DEFAULT_LADDER): Rendition[] {
  const short = Math.min(width, height);
  const rungs = [...new Set(requested)].sort((a, b) => a - b);
  const fit = rungs.filter((p) => p <= short);
  if (fit.length === 0) {
    const p = Math.max(2, Math.floor(short / 2) * 2);
    const size = frameSize(width, height, p);
    return [{ name: `${p}p`, p, ...size, videoKbps: Math.max(200, Math.round((BITRATE_KBPS[360] * p) / 360)) }];
  }
  return fit.map((p) => ({ name: `${p}p`, p, ...frameSize(width, height, p), videoKbps: BITRATE_KBPS[p] }));
}

/** Arguments that keep source metadata out of every output and make output bytes reproducible. */
const NO_METADATA = [
  "-map_metadata",
  "-1",
  "-map_chapters",
  "-1",
  "-fflags",
  "+bitexact",
  "-flags:v",
  "+bitexact",
  "-flags:a",
  "+bitexact",
];
/** Drops H.264 SEI NAL units (x264 writes its version and settings there). */
const DROP_SEI = ["-bsf:v", "filter_units=remove_types=6"];
const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ac", "2", "-ar", "48000"];
const BASE = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];

function scaleFilter(r: { width: number; height: number }): string {
  return `scale=${r.width}:${r.height}:flags=bicubic,setsar=1,format=yuv420p`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Re-checks an MP4 or JPEG we wrote with media-strip and strips it (handler names, zero-time headers and
 * other muxer leftovers become zeroed free boxes, sizes unchanged so faststart stays intact).
 */
async function verifyClean(path: string, mime: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(path));
  let clean: Uint8Array = bytes;
  if (findMetadata(bytes, mime).some((f) => !INFORMATIONAL_FINDINGS.includes(f))) {
    clean = stripMetadata(bytes, mime);
    await writeFile(path, clean);
  }
  const left = findMetadata(clean, mime).filter((f) => !INFORMATIONAL_FINDINGS.includes(f));
  if (left.length) throw new Error(`metadata left in ${path}: ${left.join(", ")}`);
}

/** master.m3u8 and the rendition playlists must reference files relatively so the folder works on IPFS. */
async function checkPlaylists(hlsDir: string, renditions: Rendition[]): Promise<void> {
  const files = ["master.m3u8", ...renditions.map((r) => join(r.name, "index.m3u8"))];
  for (const f of files) {
    const text = await readFile(join(hlsDir, f), "utf8");
    for (const line of text.split("\n")) {
      if (line && !line.startsWith("#") && (line.startsWith("/") || line.includes(":") || line.includes(".."))) {
        throw new Error(`non-relative URI in ${f}: ${line}`);
      }
    }
  }
}

/**
 * Server-side video processing (spec §4.1, architecture "Media processing"), ffmpeg in a sandbox:
 * an HLS ladder (H.264/AAC, 4 s segments, relative master.m3u8), a 720p MP4 fallback with faststart,
 * a poster JPEG from 10% in, and a muted preview of at most 6 s at 360p. Source metadata never reaches the
 * outputs (`-map_metadata -1 -map_chapters -1`, bitexact muxing, SEI dropped), and the MP4 and JPEG outputs
 * are re-checked with media-strip.
 */
export async function processVideo(
  inputPath: string,
  outDir: string,
  opts: ProcessVideoOptions = {},
): Promise<ProcessedVideo> {
  const limits = resolveLimits(opts.limits);
  const input = resolve(inputPath);
  const out = resolve(outDir);
  const size = (await stat(input)).size;
  if (size === 0) throw new MediaInputError("empty video");
  if (size > limits.maxVideoBytes)
    throw new MediaInputError(`video is ${size} bytes; the limit is ${limits.maxVideoBytes}`);
  const info: VideoInfo = await probeVideo(input, limits);
  const ladder = selectLadder(info.width, info.height, opts.ladder ?? DEFAULT_LADDER);
  const timeoutMs = limits.ffmpegBaseTimeoutMs + limits.ffmpegTimeoutPerSecondMs * info.durationSec;
  const sandbox = toolLimits(limits, timeoutMs, { cwd: out });
  const src = inputArgs(info.demuxer, input);

  await mkdir(out, { recursive: true });
  const hlsDir = join(out, "hls");
  await rm(hlsDir, { recursive: true, force: true });
  for (const r of ladder) await mkdir(join(hlsDir, r.name), { recursive: true });

  // HLS ladder in one decode: split the video, scale each copy, encode each with its own bitrate.
  const split =
    ladder.length === 1
      ? `[0:v:0]${scaleFilter(ladder[0]!)}[v0]`
      : `[0:v:0]split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join("")};` +
        ladder.map((r, i) => `[s${i}]${scaleFilter(r)}[v${i}]`).join(";");
  const hlsArgs = [...BASE, ...src, "-filter_complex", split, "-fpsmax", "60"];
  ladder.forEach((r, i) => {
    hlsArgs.push("-map", `[v${i}]`);
    if (info.hasAudio) hlsArgs.push("-map", "0:a:0");
    hlsArgs.push(`-b:v:${i}`, `${r.videoKbps}k`, `-maxrate:v:${i}`, `${Math.round(r.videoKbps * 1.07)}k`);
    hlsArgs.push(`-bufsize:v:${i}`, `${r.videoKbps * 2}k`);
  });
  hlsArgs.push(
    ...H264,
    ...(info.hasAudio ? AAC : []),
    "-force_key_frames",
    `expr:gte(t,n_forced*${SEGMENT_SEC})`,
    ...NO_METADATA,
    ...DROP_SEI,
    "-metadata",
    "service_provider=AzaadAwaaz",
    "-metadata",
    "service_name=AzaadAwaaz",
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_SEC),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    // Plain absolute paths here: the hls muxer creates directories from these strings and would treat a
    // "file:" prefix as part of a relative path. An absolute path cannot be mistaken for a protocol.
    join(hlsDir, "%v", "seg_%03d.ts"),
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    ladder.map((r, i) => (info.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`)).join(" "),
    join(hlsDir, "%v", "index.m3u8"),
  );
  await runTool("ffmpeg", hlsArgs, sandbox);
  await checkPlaylists(hlsDir, ladder);

  // MP4 fallback at 720p (or the source's size when smaller), moov first.
  const mp4Size = frameSize(info.width, info.height, Math.min(MP4_P, ladder[ladder.length - 1]!.p));
  const mp4Path = join(out, "video.mp4");
  await runTool(
    "ffmpeg",
    [
      ...BASE,
      ...src,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      scaleFilter(mp4Size),
      "-fpsmax",
      "60",
      ...H264,
      "-crf",
      "23",
      "-maxrate",
      "3000k",
      "-bufsize",
      "6000k",
      ...AAC,
      ...NO_METADATA,
      ...DROP_SEI,
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      `file:${mp4Path}`,
    ],
    sandbox,
  );
  await verifyClean(mp4Path, "video/mp4");

  // Poster from about 10% in, at the size of the top rendition.
  const at = (info.durationSec * 0.1).toFixed(3);
  const top = ladder[ladder.length - 1]!;
  const posterPath = join(out, "poster.jpg");
  await runTool(
    "ffmpeg",
    [
      ...BASE,
      "-ss",
      at,
      ...src,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      `${scaleFilter(top)},format=yuvj420p`,
      "-c:v",
      "mjpeg",
      "-q:v",
      "3",
      ...NO_METADATA,
      "-f",
      "image2",
      "-update",
      "1",
      `file:${posterPath}`,
    ],
    sandbox,
  );
  await verifyClean(posterPath, "image/jpeg");

  // Muted preview: at most 6 s from the same point (earlier when the video is short), 360p or smaller.
  const previewStart = Math.max(0, Math.min(info.durationSec * 0.1, info.durationSec - PREVIEW_SEC)).toFixed(3);
  const previewPath = join(out, "preview.mp4");
  await runTool(
    "ffmpeg",
    [
      ...BASE,
      "-ss",
      previewStart,
      ...src,
      "-map",
      "0:v:0",
      "-t",
      String(PREVIEW_SEC),
      "-an",
      "-vf",
      scaleFilter(frameSize(info.width, info.height, Math.min(PREVIEW_P, ladder[0]!.p))),
      "-fpsmax",
      "30",
      ...H264,
      "-crf",
      "28",
      ...NO_METADATA,
      ...DROP_SEI,
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      `file:${previewPath}`,
    ],
    sandbox,
  );
  await verifyClean(previewPath, "video/mp4");

  // Nothing but our outputs in the HLS folder (it is added to IPFS as a directory).
  for (const r of ladder) {
    for (const f of await readdir(join(hlsDir, r.name))) {
      if (f !== "index.m3u8" && !/^seg_\d{3,}\.ts$/.test(f)) throw new Error(`unexpected file in HLS output: ${f}`);
    }
  }

  return {
    hlsDir,
    mp4: { path: mp4Path, sha256: await sha256File(mp4Path) },
    poster: { path: posterPath, sha256: await sha256File(posterPath), width: top.width, height: top.height },
    preview: { path: previewPath, sha256: await sha256File(previewPath) },
    durationSec: info.durationSec,
    width: info.width,
    height: info.height,
  };
}
