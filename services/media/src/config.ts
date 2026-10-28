/** Input limits (spec §4.1, configurable) and sandbox budgets (spec §12). */
export interface MediaLimits {
  /** Largest accepted image, bytes (spec: 20 MB). */
  maxImageBytes: number;
  /** Largest decoded image, pixels; bigger inputs are refused before decoding (decompression bombs). */
  maxImagePixels: number;
  /** Wall-clock limit for decoding and encoding one image in the worker thread. */
  imageTimeoutMs: number;
  /** Heap limit of the image worker thread, MB (libvips' own buffers are bounded by maxImagePixels). */
  imageWorkerHeapMb: number;
  /** Largest accepted video, bytes (spec: 2 GB). */
  maxVideoBytes: number;
  /** Longest accepted video, seconds (spec: 60 minutes). */
  maxVideoDurationSec: number;
  /** Largest accepted video frame side, pixels. */
  maxVideoSide: number;
  /** ffprobe wall-clock limit. */
  probeTimeoutMs: number;
  /** ffmpeg wall-clock limit = base + factor × source duration. */
  ffmpegBaseTimeoutMs: number;
  ffmpegTimeoutPerSecondMs: number;
  /** Virtual memory limit per ffmpeg/ffprobe process (prlimit --as), bytes. */
  toolAddressSpaceBytes: number;
  /** Largest file an ffmpeg process may write (prlimit --fsize), bytes. */
  toolMaxFileBytes: number;
}

const MB = 1024 * 1024;

export const DEFAULT_LIMITS: MediaLimits = {
  maxImageBytes: 20 * MB,
  maxImagePixels: 100_000_000,
  imageTimeoutMs: 60_000,
  imageWorkerHeapMb: 256,
  maxVideoBytes: 2 * 1024 * MB,
  maxVideoDurationSec: 60 * 60,
  maxVideoSide: 8192,
  probeTimeoutMs: 30_000,
  ffmpegBaseTimeoutMs: 120_000,
  ffmpegTimeoutPerSecondMs: 20_000,
  toolAddressSpaceBytes: 8 * 1024 * MB,
  toolMaxFileBytes: 4 * 1024 * MB,
};

export function resolveLimits(overrides?: Partial<MediaLimits>): MediaLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/** Thrown when an input breaks a limit or is not an accepted format. */
export class MediaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaInputError";
  }
}
