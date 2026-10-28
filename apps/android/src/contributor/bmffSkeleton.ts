/**
 * Metadata stripping for videos too large to hold in memory, using packages/media-strip unchanged.
 *
 * media-strip never moves bytes: removed boxes become zero-filled `free` boxes of the same size, so the stripped file
 * is the original with some byte ranges rewritten. Those ranges are all outside the media data (mdat), except the
 * samples of dropped non-audio/video tracks (GPS telemetry, subtitles, timecode), which it zeroes inside mdat.
 *
 * So we build a "skeleton": every top-level box in full except mdat, whose payload is left out. media-strip strips the
 * skeleton; the bytes that changed are mapped back to file offsets and patched into a copy of the file. The samples
 * of dropped tracks are located from the sample tables (stsz/stsc/stco and moof/traf/trun, mirroring media-strip) and
 * zeroed in the file. The result is checked again: the output skeleton must have no metadata left and every zeroed
 * range must read back as zeros. Tests compare the result byte for byte with media-strip on whole files.
 */
import { findMetadata, stripMetadata } from "@azaadawaaz/media-strip";

export interface RandomAccessFile {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface Patch {
  offset: number;
  data?: Uint8Array;
  /** Write this many zero bytes instead of `data`. */
  zero?: number;
}

/** Boxes media-strip keeps at the top level (anything else it removes). */
const TOP_KEEP = new Set(["ftyp", "styp", "moov", "mdat", "moof", "mfra", "sidx", "ssix"]);
const PADDING = new Set(["free", "skip", "wide"]);
const KEEP_HANDLERS = new Set(["vide", "soun", "auxv"]);
/** Non-mdat boxes up to this size go into the skeleton; larger removable ones are rewritten directly. */
export const INLINE_LIMIT = 16 * 1024 * 1024;
/** A movie header or trailer larger than this is refused rather than loaded into memory. */
export const HEADER_LIMIT = 96 * 1024 * 1024;

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const ascii = (b: Uint8Array, s: number, e: number) => String.fromCharCode(...b.subarray(s, e));

export interface TopBox {
  type: string;
  start: number;
  header: number;
  end: number;
}

/** Top-level boxes of the file, like media-strip's walker (size 0 = to end, size 1 = 64-bit). */
export async function scanTopLevel(f: RandomAccessFile): Promise<{ boxes: TopBox[]; trailer: number }> {
  const boxes: TopBox[] = [];
  let pos = 0;
  while (pos + 8 <= f.size) {
    const h = await f.read(pos, Math.min(16, f.size - pos));
    let size = u32(h, 0);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = u64(h, 8);
      header = 16;
    } else if (size === 0) size = f.size - pos;
    if (size < header || pos + size > f.size) break;
    boxes.push({ type: ascii(h, 4, 8), start: pos, header, end: pos + size });
    pos += size;
  }
  if (pos < f.size && !boxes.some((b) => b.type === "moov")) throw new Error(`MP4: invalid box at offset ${pos}`);
  return { boxes, trailer: pos };
}

/** A skeleton segment: `len` bytes at skeleton offset `at` copied from file offset `real` (null when synthetic). */
interface Segment {
  at: number;
  len: number;
  real: number | null;
}

export interface Skeleton {
  bytes: Uint8Array;
  segments: Segment[];
  /** File ranges of mdat payloads (left out of the skeleton). */
  mdatPayloads: [number, number][];
  /** Skeleton offset → file offset of each box (for moof base offsets). */
  boxStarts: Map<number, number>;
  /** Large removable boxes rewritten directly: [file offset, size, padding]. */
  direct: { start: number; header: number; end: number; padding: boolean }[];
  /** Skeleton offset where the top-level boxes end (a trailer, if any, follows). */
  boxesEnd: number;
  trailerStart: number;
}

export async function buildSkeleton(f: RandomAccessFile): Promise<Skeleton> {
  const { boxes, trailer } = await scanTopLevel(f);
  const parts: Uint8Array[] = [];
  const segments: Segment[] = [];
  const mdatPayloads: [number, number][] = [];
  const boxStarts = new Map<number, number>();
  const direct: Skeleton["direct"] = [];
  let at = 0;
  const push = (bytes: Uint8Array, real: number | null) => {
    parts.push(bytes);
    segments.push({ at, len: bytes.length, real });
    at += bytes.length;
  };
  const emptyBox = (type: string) => Uint8Array.from([0, 0, 0, 8, ...[...type].map((c) => c.charCodeAt(0))]);
  for (const b of boxes) {
    const size = b.end - b.start;
    boxStarts.set(at, b.start);
    if (b.type === "mdat") {
      push(emptyBox("mdat"), null);
      mdatPayloads.push([b.start + b.header, b.end]);
    } else if (size > INLINE_LIMIT && !TOP_KEEP.has(b.type)) {
      direct.push({ start: b.start, header: b.header, end: b.end, padding: PADDING.has(b.type) });
      push(emptyBox("free"), null);
    } else {
      if (size > HEADER_LIMIT) throw new Error(`MP4: ${b.type} box of ${size} bytes is too large to process`);
      push(await f.read(b.start, size), b.start);
    }
  }
  const boxesEnd = at;
  if (trailer < f.size) {
    if (f.size - trailer > HEADER_LIMIT) throw new Error("MP4: trailing data is too large to process");
    push(await f.read(trailer, f.size - trailer), trailer);
  }
  const bytes = new Uint8Array(at);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
  }
  return { bytes, segments, mdatPayloads, boxStarts, direct, boxesEnd, trailerStart: trailer };
}

function toReal(sk: Skeleton, offset: number): number {
  for (const s of sk.segments) {
    if (offset >= s.at && offset < s.at + s.len) {
      if (s.real === null) throw new Error("internal: change inside a synthetic skeleton box");
      return s.real + (offset - s.at);
    }
  }
  if (offset === sk.bytes.length) return sk.trailerStart;
  throw new Error("internal: offset outside the skeleton");
}

// ---- sample ranges of dropped tracks (mirrors media-strip's walker, in file offsets) ----

interface Box {
  type: string;
  start: number;
  payload: number;
  end: number;
}

function readBox(b: Uint8Array, pos: number, limit: number): Box | null {
  if (pos + 8 > limit) return null;
  let size = u32(b, pos);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > limit) return null;
    size = u64(b, pos + 8);
    header = 16;
  } else if (size === 0) size = limit - pos;
  if (size < header || pos + size > limit) return null;
  return { type: ascii(b, pos + 4, pos + 8), start: pos, payload: pos + header, end: pos + size };
}

function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const box = readBox(b, pos, end);
    if (!box) throw new Error(`MP4: invalid box at offset ${pos}`);
    out.push(box);
    pos = box.end;
  }
  return out;
}

const child = (b: Uint8Array, p: Box, type: string) => children(b, p.payload, p.end).find((c) => c.type === type);

type Range = [number, number];

function sampleSizes(b: Uint8Array, box: Box): { count: number; at: (i: number) => number } {
  const p = box.payload;
  const count = u32(b, p + 8);
  if (box.type === "stsz") {
    const fixed = u32(b, p + 4);
    if (fixed !== 0) return { count, at: () => fixed };
    return { count, at: (i) => u32(b, p + 12 + i * 4) };
  }
  const field = b[p + 7]!;
  return {
    count,
    at: (i) => {
      if (field === 16) return (b[p + 12 + i * 2]! << 8) | b[p + 13 + i * 2]!;
      if (field === 8) return b[p + 12 + i]!;
      const byte = b[p + 12 + (i >> 1)]!;
      return i & 1 ? byte & 0x0f : byte >> 4;
    },
  };
}

function stblRanges(b: Uint8Array, stbl: Box): Range[] {
  const kids = children(b, stbl.payload, stbl.end);
  const stsz = kids.find((k) => k.type === "stsz" || k.type === "stz2");
  const stsc = kids.find((k) => k.type === "stsc");
  const stco = kids.find((k) => k.type === "stco" || k.type === "co64");
  if (!stsz || !stsc || !stco) return [];
  const sizes = sampleSizes(b, stsz);
  const chunkCount = u32(b, stco.payload + 4);
  const wide = stco.type === "co64";
  const scCount = u32(b, stsc.payload + 4);
  const ranges: Range[] = [];
  let sample = 0;
  let entry = 0;
  for (let chunk = 1; chunk <= chunkCount && sample < sizes.count; chunk++) {
    while (entry + 1 < scCount && u32(b, stsc.payload + 8 + (entry + 1) * 12) <= chunk) entry++;
    const perChunk = scCount > 0 ? u32(b, stsc.payload + 8 + entry * 12 + 4) : 0;
    const off = wide ? u64(b, stco.payload + 8 + (chunk - 1) * 8) : u32(b, stco.payload + 8 + (chunk - 1) * 4);
    let bytes = 0;
    for (let i = 0; i < perChunk && sample < sizes.count; i++, sample++) bytes += sizes.at(sample);
    if (bytes > 0) ranges.push([off, off + bytes]);
  }
  return ranges;
}

/** File ranges inside mdat that media-strip would zero: samples of dropped tracks not shared with kept tracks. */
export function droppedSampleRanges(sk: Skeleton): Range[] {
  const b = sk.bytes;
  const top = children(b, 0, sk.boxesEnd);
  const moov = top.find((t) => t.type === "moov");
  if (!moov) return [];
  const handlers = new Map<number, string>();
  const trex = new Map<number, number>();
  const drop: Range[] = [];
  const keep: Range[] = [];
  const kids = children(b, moov.payload, moov.end);
  for (const c of kids) {
    if (c.type !== "mvex") continue;
    for (const t of children(b, c.payload, c.end))
      if (t.type === "trex" && t.payload + 24 <= t.end) trex.set(u32(b, t.payload + 4), u32(b, t.payload + 16));
  }
  for (const trak of kids.filter((k) => k.type === "trak")) {
    const tkhd = child(b, trak, "tkhd");
    const mdia = child(b, trak, "mdia");
    if (!tkhd || !mdia) continue;
    const trackId = u32(b, tkhd.payload + (b[tkhd.payload] === 1 ? 20 : 12));
    const hdlr = child(b, mdia, "hdlr");
    const handler = hdlr && hdlr.payload + 12 <= hdlr.end ? ascii(b, hdlr.payload + 8, hdlr.payload + 12) : "";
    handlers.set(trackId, handler);
    const minf = child(b, mdia, "minf");
    const stbl = minf ? child(b, minf, "stbl") : undefined;
    if (stbl) (KEEP_HANDLERS.has(handler) ? keep : drop).push(...stblRanges(b, stbl));
  }
  for (const moof of top.filter((t) => t.type === "moof")) {
    const moofReal = sk.boxStarts.get(moof.start)!;
    let previousEnd = moofReal;
    let first = true;
    for (const traf of children(b, moof.payload, moof.end).filter((c) => c.type === "traf")) {
      const tk = children(b, traf.payload, traf.end);
      const tfhd = tk.find((k) => k.type === "tfhd");
      if (!tfhd) continue;
      const tf = u32(b, tfhd.payload) & 0xffffff;
      const trackId = u32(b, tfhd.payload + 4);
      let o = tfhd.payload + 8;
      let base = first ? moofReal : previousEnd;
      first = false;
      if (tf & 0x1) {
        base = u64(b, o);
        o += 8;
      } else if (tf & 0x20000) base = moofReal;
      if (tf & 0x2) o += 4;
      if (tf & 0x8) o += 4;
      let defaultSize = trex.get(trackId) ?? 0;
      if (tf & 0x10) defaultSize = u32(b, o);
      const ranges: Range[] = [];
      let cursor = base;
      for (const trun of tk.filter((k) => k.type === "trun")) {
        let p = trun.payload;
        const flags = u32(b, p) & 0xffffff;
        const count = u32(b, p + 4);
        p += 8;
        if (flags & 0x1) {
          cursor = base + (u32(b, p) | 0);
          p += 4;
        }
        if (flags & 0x4) p += 4;
        const per =
          (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
        const sizeAt = flags & 0x100 ? 4 : 0;
        let total = 0;
        for (let i = 0; i < count; i++) total += flags & 0x200 ? u32(b, p + i * per + sizeAt) : defaultSize;
        if (total > 0) ranges.push([cursor, cursor + total]);
        cursor += total;
      }
      previousEnd = cursor;
      const handler = handlers.get(trackId);
      (handler !== undefined && KEEP_HANDLERS.has(handler) ? keep : drop).push(...ranges);
    }
  }
  const keepSorted = [...keep].sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const [ds, de] of drop) {
    for (const [ms, me] of sk.mdatPayloads) {
      let s = Math.max(ds, ms);
      const e = Math.min(de, me);
      if (s >= e) continue;
      for (const [ks, ke] of keepSorted) {
        if (ke <= s) continue;
        if (ks >= e) break;
        if (ks > s) out.push([s, ks]);
        s = Math.max(s, ke);
        if (s >= e) break;
      }
      if (s < e) out.push([s, e]);
    }
  }
  return mergeRanges(out);
}

function mergeRanges(rs: Range[]): Range[] {
  const sorted = [...rs].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export interface VideoPlan {
  patches: Patch[];
  truncate?: number;
  /** Metadata found in the input (media-strip names). */
  removed: string[];
  /** Ranges that must read back as zeros after patching. */
  zeroed: Range[];
}

/** Work out what to change in the file, without touching it. */
export async function planVideoStrip(f: RandomAccessFile, mime: string): Promise<VideoPlan> {
  const sk = await buildSkeleton(f);
  const removed = new Set(findMetadata(sk.bytes, mime));
  const out = stripMetadata(sk.bytes, mime, { keepIcc: false });
  const patches: Patch[] = [];
  const n = Math.min(out.length, sk.bytes.length);
  for (let i = 0; i < n; i++) {
    if (out[i] === sk.bytes[i]) continue;
    let j = i;
    while (j < n && out[j] !== sk.bytes[j]) j++;
    // Split runs at segment boundaries so each maps to one contiguous file range.
    let k = i;
    while (k < j) {
      const seg = sk.segments.find((s) => k >= s.at && k < s.at + s.len)!;
      const end = Math.min(j, seg.at + seg.len);
      patches.push({ offset: toReal(sk, k), data: out.slice(k, end) });
      k = end;
    }
    i = j - 1;
  }
  const truncate = out.length < sk.bytes.length ? toReal(sk, out.length) : undefined;
  const zeroed: Range[] = [];
  for (const d of sk.direct) {
    if (d.padding) removed.add("mp4:free-data");
    else {
      removed.add("mp4:other");
      patches.push({ offset: d.start + 4, data: Uint8Array.from([0x66, 0x72, 0x65, 0x65]) });
    }
    patches.push({ offset: d.start + d.header, zero: d.end - d.start - d.header });
    zeroed.push([d.start + d.header, d.end]);
  }
  if (removed.has("mp4:data-track")) {
    for (const [s, e] of droppedSampleRanges(sk)) {
      patches.push({ offset: s, zero: e - s });
      zeroed.push([s, e]);
    }
  }
  patches.sort((a, b) => a.offset - b.offset);
  return { patches, truncate, removed: [...removed], zeroed };
}

/** Re-check a stripped file: no metadata left in its skeleton and every zeroed range reads back as zeros. */
export async function verifyVideoStrip(f: RandomAccessFile, mime: string, zeroed: Range[]): Promise<string[]> {
  const sk = await buildSkeleton(f);
  const left = findMetadata(sk.bytes, mime);
  // Large boxes are checked here rather than in the skeleton: each must now be padding (its payload is in `zeroed`).
  if (sk.direct.some((d) => !d.padding)) left.push("mp4:other");
  const STEP = 1024 * 1024;
  for (const [s, e] of zeroed) {
    for (let o = s; o < e; o += STEP) {
      const chunk = await f.read(o, Math.min(STEP, e - o));
      if (chunk.some((x) => x !== 0)) {
        left.push("mp4:data-track");
        return left;
      }
    }
  }
  return left;
}
