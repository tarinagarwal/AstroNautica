import { open } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { detectMime } from "@azaadawaaz/media-strip";
import { MediaInputError, type MediaLimits } from "./config.js";
import { runTool, type ToolLimits } from "./sandbox.js";

/** ffmpeg demuxer names we allow; the input format is always forced so ffmpeg never guesses. */
export type Demuxer = "mov" | "matroska";

export interface VideoInfo {
  demuxer: Demuxer;
  durationSec: number;
  /** Display dimensions (after the rotation in the track matrix). */
  width: number;
  height: number;
  hasAudio: boolean;
  fps: number;
}

/**
 * Sniffs the container from its first bytes: ISO BMFF (MP4/MOV/3GP, what phones record) or Matroska/WebM
 * (what browsers' MediaRecorder writes). Anything else is refused, which also keeps ffmpeg from ever
 * opening playlists, concat lists or image sequences that could make it read other files.
 */
export async function sniffVideo(path: string): Promise<Demuxer> {
  const fh = await open(path, "r");
  try {
    const head = new Uint8Array(64);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "matroska";
    const mime = detectMime(bytes);
    if (mime === "video/mp4" || mime === "video/quicktime" || mime === "video/3gpp") return "mov";
    throw new MediaInputError(`unsupported video container: ${mime ?? "unknown"}`);
  } finally {
    await fh.close();
  }
}

/** Input arguments shared by every ffmpeg/ffprobe call: forced demuxer, local files only. */
export function inputArgs(demuxer: Demuxer, path: string): string[] {
  return ["-protocol_whitelist", "file", "-f", demuxer, "-i", `file:${resolve(path)}`];
}

/** Sandbox limits for one tool run with the given wall-clock budget. */
export function toolLimits(limits: MediaLimits, timeoutMs: number, extra: Partial<ToolLimits> = {}): ToolLimits {
  return {
    timeoutMs,
    addressSpaceBytes: limits.toolAddressSpaceBytes,
    cpuSeconds: (timeoutMs / 1000) * availableParallelism(),
    maxFileBytes: limits.toolMaxFileBytes,
    maxOpenFiles: 256,
    ...extra,
  };
}

interface ProbeJson {
  format?: { duration?: string };
  streams?: {
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    side_data_list?: { side_data_type?: string; rotation?: number }[];
    tags?: { rotate?: string };
  }[];
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split("/").map(Number);
  return d ? n! / d : (n ?? 0);
}

/** Runs ffprobe (sandboxed) and validates duration and frame size against the limits. */
export async function probeVideo(path: string, limits: MediaLimits): Promise<VideoInfo> {
  const demuxer = await sniffVideo(path);
  const { stdout } = await runTool(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...inputArgs(demuxer, path)],
    toolLimits(limits, limits.probeTimeoutMs, { maxStdoutBytes: 4 * 1024 * 1024, maxFileBytes: 1 }),
  );
  const json = JSON.parse(stdout) as ProbeJson;
  const video = json.streams?.find((s) => s.codec_type === "video" && s.width && s.height);
  if (!video) throw new MediaInputError("no video stream");
  const durationSec = Number(json.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new MediaInputError("unknown video duration");
  if (durationSec > limits.maxVideoDurationSec) {
    throw new MediaInputError(`video is ${Math.round(durationSec)} s; the limit is ${limits.maxVideoDurationSec} s`);
  }
  const rotation =
    video.side_data_list?.find((d) => d.side_data_type === "Display Matrix")?.rotation ??
    Number(video.tags?.rotate ?? 0);
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const width = quarter ? video.height! : video.width!;
  const height = quarter ? video.width! : video.height!;
  if (width > limits.maxVideoSide || height > limits.maxVideoSide) {
    throw new MediaInputError(`video frame ${width}x${height} exceeds ${limits.maxVideoSide} px`);
  }
  return {
    demuxer,
    durationSec: Math.round(durationSec * 1000) / 1000,
    width,
    height,
    hasAudio: json.streams?.some((s) => s.codec_type === "audio") ?? false,
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
  };
}
