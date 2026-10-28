import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURES = new URL("./fixtures/", import.meta.url);

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

function hasTool(cmd: string, arg: string): boolean {
  return spawnSync(cmd, [arg], { stdio: "ignore" }).status === 0;
}

export const HAS_FFMPEG = hasTool("ffmpeg", "-version") && hasTool("ffprobe", "-version");
export const HAS_EXIFTOOL = hasTool("exiftool", "-ver");

/** Writes bytes to a temporary file, runs `fn` with its path, and removes it. */
export function withTempFile<T>(bytes: Uint8Array, ext: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "media-strip-"));
  const path = join(dir, `file${ext}`);
  writeFileSync(path, bytes);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Decodes every frame of every audio/video stream with ffmpeg; returns per-frame hashes (hash column only). */
export function frameHashes(bytes: Uint8Array, ext: string, extraInputArgs: string[] = []): string[] {
  return withTempFile(bytes, ext, (p) => {
    const out = execFileSync(
      "ffmpeg",
      ["-v", "error", "-xerror", ...extraInputArgs, "-i", p, "-map", "0:v?", "-map", "0:a?", "-f", "framemd5", "-"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const cols = l.split(",").map((c) => c.trim());
        return `${cols[0]}:${cols[5]}`;
      });
  });
}

export interface ProbeResult {
  format: { tags?: Record<string, string> };
  streams: { codec_type: string; tags?: Record<string, string> }[];
}

export function ffprobe(bytes: Uint8Array, ext: string): ProbeResult {
  return withTempFile(bytes, ext, (p) =>
    JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", p], { encoding: "utf8" }),
    ),
  );
}

/** exiftool tag dump as { "Group:Tag": value }. */
export function exiftool(bytes: Uint8Array, ext: string): Record<string, unknown> {
  return withTempFile(bytes, ext, (p) => {
    const out = execFileSync("exiftool", ["-j", "-G1", "-a", "-n", p], { encoding: "utf8" });
    return (JSON.parse(out) as Record<string, unknown>[])[0]!;
  });
}

/** exiftool tags that would identify a person, device, place or time. */
export const IDENTIFYING_EXIFTOOL_TAG =
  /GPS|Make$|Model$|Serial|DateTimeOriginal|:CreateDate|:ModifyDate|Creator|By-line|City|Country|Author|Comment|Software|Location|Artist|Description|ThumbnailImage|Keys:|UserData|XMP/;

/** Returns the identifying exiftool tags whose value is set (zero dates count as unset). */
export function identifyingTags(tags: Record<string, unknown>): string[] {
  return Object.entries(tags)
    .filter(([k]) => IDENTIFYING_EXIFTOOL_TAG.test(k) && !/^(System|ExifTool|ICC_Profile|ICC-header):/.test(k))
    .filter(([, v]) => !(typeof v === "string" && /^0000:00:00 00:00:00/.test(v)) && v !== 0)
    .map(([k, v]) => `${k}=${String(v)}`);
}

/* ---------------------------------------------------------------- byte builders */

export function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u16(v: number): Uint8Array {
  return Uint8Array.of(v >> 8, v & 0xff);
}

export function u32(v: number): Uint8Array {
  return Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

export function u64(v: number): Uint8Array {
  return cat(u32(Math.floor(v / 0x100000000)), u32(v >>> 0));
}

/** A JPEG marker segment: FF marker, length, payload. */
export function segment(marker: number, payload: Uint8Array): Uint8Array {
  return cat(Uint8Array.of(0xff, marker), u16(payload.length + 2), payload);
}

/**
 * Minimal TIFF (big- or little-endian) with IFD0 holding Orientation and, optionally, a GPS IFD with a
 * latitude reference: enough for the Exif parser.
 */
export function buildTiff(opts: { orientation?: number; gps?: boolean; littleEndian?: boolean }): Uint8Array {
  const le = opts.littleEndian ?? false;
  const entries: [number, number, number, number][] = []; // tag, type, count, value
  if (opts.orientation) entries.push([0x0112, 3, 1, opts.orientation]);
  const ifd0Size = 2 + entries.length * 12 + (opts.gps ? 12 : 0) + 4;
  const gpsOffset = 8 + ifd0Size;
  if (opts.gps) entries.push([0x8825, 4, 1, gpsOffset]);
  const gpsIfd: [number, number, number, number][] = opts.gps ? [[0x0001, 2, 2, 0x4e000000]] : [];
  const size = gpsOffset + (opts.gps ? 2 + gpsIfd.length * 12 + 4 : 0);
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  const writeIfd = (at: number, list: [number, number, number, number][]): void => {
    v.setUint16(at, list.length, le);
    list.forEach(([tag, type, count, value], i) => {
      const e = at + 2 + i * 12;
      v.setUint16(e, tag, le);
      v.setUint16(e + 2, type, le);
      v.setUint32(e + 4, count, le);
      if (type === 3) v.setUint16(e + 8, value, le);
      else if (type === 2) v.setUint32(e + 8, value, false);
      else v.setUint32(e + 8, value, le);
    });
    v.setUint32(at + 2 + list.length * 12, 0, le);
  };
  writeIfd(8, entries);
  if (opts.gps) writeIfd(gpsOffset, gpsIfd);
  return buf;
}

/** JPEG markers in file order (0 = entropy-coded data), with their raw bytes. */
export function jpegSegments(b: Uint8Array): { marker: number; bytes: Uint8Array }[] {
  const out: { marker: number; bytes: Uint8Array }[] = [];
  let pos = 2;
  out.push({ marker: 0xd8, bytes: b.subarray(0, 2) });
  while (pos < b.length) {
    const m = b[pos + 1]!;
    if (m === 0xd9) {
      out.push({ marker: m, bytes: b.subarray(pos, pos + 2) });
      break;
    }
    if (m >= 0xd0 && m <= 0xd7) {
      out.push({ marker: m, bytes: b.subarray(pos, pos + 2) });
      pos += 2;
      continue;
    }
    const len = (b[pos + 2]! << 8) | b[pos + 3]!;
    out.push({ marker: m, bytes: b.subarray(pos, pos + 2 + len) });
    pos += 2 + len;
    if (m === 0xda) {
      let i = pos;
      while (i < b.length && !(b[i] === 0xff && b[i + 1] !== 0 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7))) i++;
      out.push({ marker: 0, bytes: b.subarray(pos, i) });
      pos = i;
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const td = cat(ascii(type), data);
  return cat(u32(data.length), td, u32(crc32(td)));
}

export function pngChunks(b: Uint8Array): { type: string; data: Uint8Array; crc: number }[] {
  const out: { type: string; data: Uint8Array; crc: number }[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = v.getUint32(pos);
    const type = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
    out.push({ type, data: b.subarray(pos + 8, pos + 8 + len), crc: v.getUint32(pos + 8 + len) });
    pos += 12 + len;
  }
  return out;
}

export function riffChunks(b: Uint8Array): { fourcc: string; data: Uint8Array }[] {
  const out: { fourcc: string; data: Uint8Array }[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 12;
  while (pos + 8 <= b.length) {
    const size = v.getUint32(pos + 4, true);
    out.push({ fourcc: String.fromCharCode(...b.subarray(pos, pos + 4)), data: b.subarray(pos + 8, pos + 8 + size) });
    pos += 8 + size + (size & 1);
  }
  return out;
}

/* ---------------------------------------------------------------- ISO BMFF */

export interface TBox {
  type: string;
  start: number;
  header: number;
  end: number;
}

export function boxes(b: Uint8Array, start = 0, end = b.length): TBox[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: TBox[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = v.getUint32(pos);
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    out.push({ type: String.fromCharCode(...b.subarray(pos + 4, pos + 8)), start: pos, header, end: pos + size });
    pos += size;
  }
  return out;
}

export function findPath(b: Uint8Array, path: string[]): TBox[] {
  let level: TBox[] = boxes(b);
  let found: TBox[] = [];
  for (let i = 0; i < path.length; i++) {
    found = level.filter((x) => x.type === path[i]);
    if (i < path.length - 1) level = found.flatMap((x) => boxes(b, x.start + x.header, x.end));
  }
  return found;
}

/** Concatenated payloads of all top-level mdat boxes. */
export function mdatBytes(b: Uint8Array): Uint8Array {
  return cat(
    ...boxes(b)
      .filter((x) => x.type === "mdat")
      .map((x) => b.subarray(x.start + x.header, x.end)),
  );
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return cat(u32(payload.length + 8), ascii(type), payload);
}

/**
 * Rebuilds moov with version-1 (64-bit time) mvhd, tkhd and mdhd boxes carrying the given times. Only
 * valid for files whose moov comes after mdat (sizes before mdat do not change).
 */
export function upgradeTimesToV1(b: Uint8Array, time: number): Uint8Array {
  const top = boxes(b);
  const moovIndex = top.findIndex((x) => x.type === "moov");
  const mdatIndex = top.findIndex((x) => x.type === "mdat");
  if (moovIndex < mdatIndex) throw new Error("moov must follow mdat");
  const containers = new Set(["moov", "trak", "mdia"]);
  const rebuild = (bx: TBox): Uint8Array => {
    const payload = b.subarray(bx.start + bx.header, bx.end);
    if (containers.has(bx.type)) {
      return box(bx.type, cat(...boxes(b, bx.start + bx.header, bx.end).map(rebuild)));
    }
    if ((bx.type === "mvhd" || bx.type === "tkhd" || bx.type === "mdhd") && payload[0] === 0) {
      const flags = payload.subarray(1, 4);
      const rest = payload.subarray(12); // after version/flags, creation, modification
      if (bx.type === "tkhd") {
        // v0: track_ID(4) reserved(4) duration(4) ...; v1: track_ID(4) reserved(4) duration(8) ...
        const head = rest.subarray(0, 8);
        const duration = new DataView(rest.buffer, rest.byteOffset + 8, 4).getUint32(0);
        return box(bx.type, cat(Uint8Array.of(1), flags, u64(time), u64(time), head, u64(duration), rest.subarray(12)));
      }
      // mvhd/mdhd v0: timescale(4) duration(4) ...; v1: timescale(4) duration(8) ...
      const timescale = rest.subarray(0, 4);
      const duration = new DataView(rest.buffer, rest.byteOffset + 4, 4).getUint32(0);
      return box(
        bx.type,
        cat(Uint8Array.of(1), flags, u64(time), u64(time), timescale, u64(duration), rest.subarray(8)),
      );
    }
    return b.subarray(bx.start, bx.end);
  };
  return cat(...top.map((x) => (x.type === "moov" ? rebuild(x) : b.subarray(x.start, x.end))));
}
