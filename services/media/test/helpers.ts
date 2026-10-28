import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HAS_FFMPEG =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

export const MEDIA_STRIP_FIXTURES = new URL("../../../packages/media-strip/test/fixtures/", import.meta.url);

export function stripFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, MEDIA_STRIP_FIXTURES)));
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "azaad-media-test-"));
}

export function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

/** Generates a test video (testsrc2 + optional 440 Hz tone) with phone-style metadata. */
export function makeVideo(
  path: string,
  opts: { width: number; height: number; seconds: number; audio?: boolean; rate?: number },
): string {
  const rate = opts.rate ?? 25;
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${opts.width}x${opts.height}:rate=${rate}`,
    ...(opts.audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"] : []),
    "-t",
    String(opts.seconds),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    ...(opts.audio ? ["-c:a", "aac", "-b:a", "64k"] : []),
    "-metadata",
    "location=+28.6139+077.2090/",
    "-metadata",
    "make=Samsung",
    "-metadata",
    "model=SM-G991B",
    "-metadata",
    "creation_time=2024-05-01T10:20:30Z",
    "-movflags",
    "use_metadata_tags",
    path,
  ]);
  return path;
}

export interface Probe {
  format: { duration?: string; tags?: Record<string, string> };
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    tags?: Record<string, string>;
    side_data_list?: unknown[];
  }[];
  programs?: { tags?: Record<string, string> }[];
}

export function ffprobe(path: string, extra: string[] = []): Probe {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", ...extra, "-show_format", "-show_streams", "-show_programs", "-of", "json", path],
      { encoding: "utf8" },
    ),
  );
}

/** Decodes every frame; throws on any decoding error. */
export function decodeAll(path: string, extra: string[] = []): void {
  execFileSync("ffmpeg", ["-v", "error", "-xerror", ...extra, "-i", path, "-f", "null", "-"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export function contains(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(needle, 0, "latin1");
}
