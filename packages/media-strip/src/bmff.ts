import { ascii, indexOfAscii, u16be, u32be, u64be } from "./bytes.js";
import { MalformedMediaError, UnsupportedFormatError } from "./errors.js";

/*
 * ISO base media file format (MP4, MOV, 3GP) metadata removal.
 *
 * Approach: every box that must go is turned, in place, into a `free` box of exactly the same size and its
 * payload is overwritten with zeros. Nothing moves, so:
 *   - no size field anywhere changes (moov, trak, moof keep their sizes),
 *   - chunk offsets (stco/co64), trun data offsets, sidx/tfra references all stay valid whether moov is
 *     before or after mdat, and fragmented files keep working,
 *   - the media data is byte-identical.
 * Rewriting stco/co64 after shrinking moov would also work for plain files, but it is easy to get wrong for
 * the less common layouts (fragments with explicit base offsets, sidx, multiple mdat boxes, self-referencing
 * data references) and a bug there yields a file that silently plays garbage. The price of the free-box
 * approach is that the output is as large as the input; the zeroed bytes compress to nothing.
 *
 * What is removed (turned into zeroed `free`):
 *   - `udta` anywhere (©xyz location, ©mak/©mod device, ©day, loci, XMP_, vendor boxes), `meta` at file,
 *     moov and trak level (Apple keys: ISO6709 location, make, model, software, creation date), `uuid`
 *     boxes (XMP and vendor data), `prft` (wall-clock time), unknown boxes at file, moov and trak level;
 *   - tracks that are neither video nor audio (timed metadata such as GoPro GPMF or Apple mebx, subtitles,
 *     timecode, hint), whose samples inside mdat are zeroed too: those samples are the only bytes of mdat
 *     that change, audio and video samples are never touched;
 *   - bytes after the last box (vendor trailers) are cut off.
 * What is zeroed in place: creation and modification times in mvhd, tkhd and mdhd (version 0 and 1), the
 * payload of existing free/skip boxes, the vendor and compressor-name fields of video and audio sample
 * entries, and handler names (these name the recording app or device family).
 */

interface Box {
  type: string;
  start: number;
  /** Offset of the payload (after size, type, optional 64-bit size). */
  payload: number;
  end: number;
}

/** Reads the box at `pos` inside [pos, limit). Returns null when the header is not a valid box. */
function readBox(b: Uint8Array, pos: number, limit: number): Box | null {
  if (pos + 8 > limit) return null;
  let size = u32be(b, pos);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > limit) return null;
    size = u64be(b, pos + 8);
    header = 16;
  } else if (size === 0) {
    size = limit - pos;
  }
  if (size < header || pos + size > limit) return null;
  return { type: ascii(b, pos + 4, pos + 8), start: pos, payload: pos + header, end: pos + size };
}

function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const box = readBox(b, pos, end);
    if (!box) throw new MalformedMediaError(`MP4: invalid box at offset ${pos}`);
    out.push(box);
    pos = box.end;
  }
  return out;
}

function child(b: Uint8Array, parent: Box, type: string): Box | undefined {
  return children(b, parent.payload, parent.end).find((c) => c.type === type);
}

function isZero(b: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

type Range = [number, number];

const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];
const KEEP_HANDLERS = new Set(["vide", "soun", "auxv"]);
const TOP_KEEP = new Set(["ftyp", "styp", "moov", "mdat", "moof", "mfra", "sidx", "ssix"]);
const PADDING = new Set(["free", "skip", "wide"]);

class Walker {
  readonly found = new Set<string>();
  /** Sample ranges of tracks being dropped and of tracks being kept (to never zero shared bytes). */
  private readonly dropRanges: Range[] = [];
  private readonly keepRanges: Range[] = [];
  private readonly mdatPayloads: Range[] = [];
  /** track_ID → handler type, from moov. */
  private readonly handlers = new Map<number, string>();
  /** track_ID → trex default_sample_size. */
  private readonly trexSize = new Map<number, number>();
  private anyDropped = false;

  constructor(
    private readonly b: Uint8Array,
    private readonly strip: boolean,
  ) {}

  /** Turns a box into a `free` box of the same size with a zeroed payload (keeping a 64-bit size header). */
  private remove(box: Box, reasons: string[]): void {
    for (const r of reasons) this.found.add(r);
    if (!this.strip) return;
    this.b[box.start + 4] = 0x66; // f
    this.b[box.start + 5] = 0x72; // r
    this.b[box.start + 6] = 0x65; // e
    this.b[box.start + 7] = 0x65; // e
    this.b.fill(0, box.payload, box.end);
  }

  private zero(start: number, end: number, reason: string): void {
    if (end <= start || isZero(this.b, start, end)) return;
    this.found.add(reason);
    if (this.strip) this.b.fill(0, start, end);
  }

  /** Walks the file. Returns the offset at which a trailer (bytes that are not boxes) starts. */
  run(): number {
    const b = this.b;
    const top: Box[] = [];
    let pos = 0;
    let trailer = b.length;
    while (pos + 8 <= b.length) {
      const box = readBox(b, pos, b.length);
      if (!box) {
        if (!top.some((t) => t.type === "moov")) throw new MalformedMediaError(`MP4: invalid box at offset ${pos}`);
        trailer = pos;
        break;
      }
      top.push(box);
      pos = box.end;
    }
    if (pos < b.length && trailer === b.length) trailer = pos;
    const moov = top.filter((t) => t.type === "moov");
    if (moov.length !== 1) throw new MalformedMediaError("MP4: expected exactly one moov box");
    for (const t of top) if (t.type === "mdat") this.mdatPayloads.push([t.payload, t.end]);
    this.moov(moov[0]!);
    for (const t of top) {
      if (t.type === "moov") continue;
      if (t.type === "moof") this.moof(t);
      else if (PADDING.has(t.type)) this.zero(t.payload, t.end, "mp4:free-data");
      else if (TOP_KEEP.has(t.type)) continue;
      else this.removeGeneric(t);
    }
    if (this.anyDropped) this.zeroDroppedSamples();
    if (trailer < b.length) this.found.add("mp4:trailer");
    return trailer;
  }

  /** Removes udta/meta/uuid/prft/unknown boxes, recording what they held. */
  private removeGeneric(box: Box): void {
    const b = this.b;
    switch (box.type) {
      case "udta": {
        const reasons = ["mp4:udta"];
        if (this.hasLocation(box)) reasons.push("mp4:location");
        if (indexOfAscii(b, "XMP_", box.payload, box.end) >= 0) reasons.push("xmp");
        if (indexOfAscii(b, "meta", box.payload, box.end) >= 0) reasons.push("mp4:meta");
        this.remove(box, reasons);
        return;
      }
      case "meta": {
        const reasons = ["mp4:meta"];
        if (this.hasLocation(box)) reasons.push("mp4:location");
        this.remove(box, reasons);
        return;
      }
      case "uuid": {
        const reasons = ["mp4:uuid"];
        if (XMP_UUID.every((v, i) => b[box.payload + i] === v)) reasons.push("xmp");
        if (indexOfAscii(b, "GPSLatitude", box.payload, box.end) >= 0) reasons.push("gps");
        this.remove(box, reasons);
        return;
      }
      case "loci":
      case "\xa9xyz":
        this.remove(box, ["mp4:location"]);
        return;
      case "prft":
        this.remove(box, ["mp4:timestamps"]);
        return;
      case "cmov":
        throw new UnsupportedFormatError(
          "video/quicktime",
          "Compressed QuickTime movie headers (cmov) are not supported",
        );
      default:
        this.remove(box, ["mp4:other"]);
    }
  }

  private hasLocation(box: Box): boolean {
    const b = this.b;
    return (
      indexOfAscii(b, "\xa9xyz", box.payload, box.end) >= 0 ||
      indexOfAscii(b, "loci", box.payload, box.end) >= 0 ||
      indexOfAscii(b, "location", box.payload, box.end) >= 0 ||
      indexOfAscii(b, "GPSCoordinates", box.payload, box.end) >= 0
    );
  }

  /** Zeroes creation and modification times of mvhd/tkhd/mdhd (version 0: 32-bit, version 1: 64-bit). */
  private zeroTimes(box: Box): void {
    const p = box.payload;
    const width = this.b[p] === 1 ? 8 : 4;
    if (p + 4 + 2 * width > box.end) throw new MalformedMediaError(`MP4: ${box.type} too short`);
    this.zero(p + 4, p + 4 + 2 * width, "mp4:timestamps");
  }

  /** Zeroes the QuickTime manufacturer/flags fields and the name of a handler box. */
  private scrubHandler(box: Box): void {
    // FullBox header (4), pre_defined / component type (4), handler_type (4), reserved / manufacturer (12), name.
    const p = box.payload;
    if (p + 12 > box.end) throw new MalformedMediaError("MP4: hdlr too short");
    this.zero(Math.min(p + 12, box.end), box.end, "mp4:encoder");
  }

  private moov(moov: Box): void {
    const kids = children(this.b, moov.payload, moov.end);
    for (const c of kids) if (c.type === "mvex") this.mvex(c);
    for (const c of kids) {
      switch (c.type) {
        case "mvhd":
          this.zeroTimes(c);
          break;
        case "trak":
          this.trak(c);
          break;
        case "mvex":
        case "iods":
        case "pssh":
          break;
        case "free":
        case "skip":
          this.zero(c.payload, c.end, "mp4:free-data");
          break;
        default:
          this.removeGeneric(c);
      }
    }
  }

  private mvex(mvex: Box): void {
    for (const c of children(this.b, mvex.payload, mvex.end)) {
      if (c.type === "trex" && c.payload + 24 <= c.end) {
        this.trexSize.set(u32be(this.b, c.payload + 4), u32be(this.b, c.payload + 16));
      }
    }
  }

  private trak(trak: Box): void {
    const b = this.b;
    const tkhd = child(b, trak, "tkhd");
    const mdia = child(b, trak, "mdia");
    if (!tkhd || !mdia) throw new MalformedMediaError("MP4: trak without tkhd or mdia");
    const trackId = u32be(b, tkhd.payload + (b[tkhd.payload] === 1 ? 20 : 12));
    const hdlr = child(b, mdia, "hdlr");
    const handler = hdlr && hdlr.payload + 12 <= hdlr.end ? ascii(b, hdlr.payload + 8, hdlr.payload + 12) : "";
    this.handlers.set(trackId, handler);
    const stbl = this.stblOf(mdia);
    if (!KEEP_HANDLERS.has(handler)) {
      this.anyDropped = true;
      if (stbl) this.dropRanges.push(...this.sampleRanges(stbl));
      this.remove(trak, ["mp4:data-track"]);
      return;
    }
    if (stbl) this.keepRanges.push(...this.sampleRanges(stbl));
    for (const c of children(b, trak.payload, trak.end)) {
      switch (c.type) {
        case "tkhd":
          this.zeroTimes(c);
          break;
        case "mdia":
          this.nested(c, handler);
          break;
        case "edts":
        case "tref":
        case "tapt":
          break;
        case "free":
        case "skip":
          this.zero(c.payload, c.end, "mp4:free-data");
          break;
        default:
          this.removeGeneric(c);
      }
    }
  }

  private stblOf(mdia: Box): Box | undefined {
    const minf = child(this.b, mdia, "minf");
    return minf ? child(this.b, minf, "stbl") : undefined;
  }

  /** Inside mdia/minf/stbl only metadata boxes are removed; codec-related boxes stay untouched. */
  private nested(box: Box, handler: string): void {
    for (const c of children(this.b, box.payload, box.end)) {
      switch (c.type) {
        case "mdhd":
          this.zeroTimes(c);
          break;
        case "hdlr":
          this.scrubHandler(c);
          break;
        case "minf":
        case "stbl":
          this.nested(c, handler);
          break;
        case "stsd":
          this.stsd(c, handler);
          break;
        case "udta":
        case "meta":
        case "uuid":
          this.removeGeneric(c);
          break;
        case "free":
        case "skip":
          this.zero(c.payload, c.end, "mp4:free-data");
          break;
        default:
          break;
      }
    }
  }

  /** Zeroes the vendor field of video/audio sample entries and the compressor name of video ones. */
  private stsd(stsd: Box, handler: string): void {
    const b = this.b;
    if (stsd.payload + 8 > stsd.end) throw new MalformedMediaError("MP4: stsd too short");
    for (const e of children(b, stsd.payload + 8, stsd.end)) {
      const p = e.payload;
      if (p + 16 <= e.end) this.zero(p + 12, p + 16, "mp4:encoder"); // QuickTime vendor (reserved in ISO)
      if (handler !== "soun" && p + 74 <= e.end) this.zero(p + 42, p + 74, "mp4:encoder"); // compressorname
    }
  }

  private moof(moof: Box): void {
    const b = this.b;
    const trafs: { box: Box; trackId: number; ranges: Range[]; implicitBase: boolean }[] = [];
    let previousDataEnd = moof.start;
    for (const c of children(b, moof.payload, moof.end)) {
      if (c.type === "mfhd" || c.type === "pssh") continue;
      if (c.type !== "traf") {
        if (PADDING.has(c.type)) this.zero(c.payload, c.end, "mp4:free-data");
        else this.removeGeneric(c);
        continue;
      }
      const info = this.trafRanges(c, moof, trafs.length === 0 ? moof.start : previousDataEnd);
      previousDataEnd = info.dataEnd;
      trafs.push({ box: c, trackId: info.trackId, ranges: info.ranges, implicitBase: info.implicitBase });
    }
    trafs.forEach((t, i) => {
      const handler = this.handlers.get(t.trackId);
      if (handler === undefined || !KEEP_HANDLERS.has(handler)) {
        this.anyDropped = true;
        this.dropRanges.push(...t.ranges);
        // A later traf whose base offset is implied by the end of this traf's data would break if this traf
        // disappeared; then it stays in place (its samples are still zeroed and its track is gone from moov).
        if (!trafs.slice(i + 1).some((later) => later.implicitBase)) this.remove(t.box, ["mp4:data-track"]);
        return;
      }
      this.keepRanges.push(...t.ranges);
      for (const k of children(b, t.box.payload, t.box.end)) {
        if (k.type === "uuid" || k.type === "udta" || k.type === "meta") this.removeGeneric(k);
        else if (k.type === "free" || k.type === "skip") this.zero(k.payload, k.end, "mp4:free-data");
      }
    });
  }

  /** Byte ranges of the samples a traf describes (ISO/IEC 14496-12 §8.8.7, §8.8.8). */
  private trafRanges(
    traf: Box,
    moof: Box,
    implicitBase: number,
  ): { trackId: number; ranges: Range[]; dataEnd: number; implicitBase: boolean } {
    const b = this.b;
    const kids = children(b, traf.payload, traf.end);
    const tfhd = kids.find((k) => k.type === "tfhd");
    if (!tfhd || tfhd.payload + 8 > tfhd.end) throw new MalformedMediaError("MP4: traf without tfhd");
    const tf = u32be(b, tfhd.payload) & 0xffffff;
    const trackId = u32be(b, tfhd.payload + 4);
    let o = tfhd.payload + 8;
    let base = implicitBase;
    if (tf & 0x1) {
      base = u64be(b, o);
      o += 8;
    } else if (tf & 0x20000) base = moof.start;
    if (tf & 0x2) o += 4;
    if (tf & 0x8) o += 4;
    let defaultSize = this.trexSize.get(trackId) ?? 0;
    if (tf & 0x10) {
      if (o + 4 > tfhd.end) throw new MalformedMediaError("MP4: tfhd too short");
      defaultSize = u32be(b, o);
    }
    const ranges: Range[] = [];
    let cursor = base;
    for (const trun of kids.filter((k) => k.type === "trun")) {
      let p = trun.payload;
      if (p + 8 > trun.end) throw new MalformedMediaError("MP4: trun too short");
      const flags = u32be(b, p) & 0xffffff;
      const count = u32be(b, p + 4);
      p += 8;
      if (flags & 0x1) {
        cursor = base + (u32be(b, p) | 0); // signed 32-bit offset
        p += 4;
      }
      if (flags & 0x4) p += 4;
      const perSample =
        (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
      if (p + count * perSample > trun.end) throw new MalformedMediaError("MP4: trun overruns box");
      const sizeAt = flags & 0x100 ? 4 : 0;
      let total = 0;
      for (let i = 0; i < count; i++) {
        total += flags & 0x200 ? u32be(b, p + i * perSample + sizeAt) : defaultSize;
      }
      if (total > 0) ranges.push([cursor, cursor + total]);
      cursor += total;
    }
    return { trackId, ranges, dataEnd: cursor, implicitBase: (tf & 0x20001) === 0 };
  }

  /** Byte ranges of a non-fragmented track's samples, one per chunk (from stsz/stz2, stsc, stco/co64). */
  private sampleRanges(stbl: Box): Range[] {
    const b = this.b;
    const kids = children(b, stbl.payload, stbl.end);
    const stsz = kids.find((k) => k.type === "stsz" || k.type === "stz2");
    const stsc = kids.find((k) => k.type === "stsc");
    const stco = kids.find((k) => k.type === "stco" || k.type === "co64");
    if (!stsz || !stsc || !stco) return [];
    const sizeOf = this.sampleSizes(stsz);
    const sampleCount = sizeOf.count;
    const chunkCount = u32be(b, stco.payload + 4);
    const wide = stco.type === "co64";
    if (stco.payload + 8 + chunkCount * (wide ? 8 : 4) > stco.end) throw new MalformedMediaError("MP4: stco overrun");
    const scCount = u32be(b, stsc.payload + 4);
    if (stsc.payload + 8 + scCount * 12 > stsc.end) throw new MalformedMediaError("MP4: stsc overrun");
    const ranges: Range[] = [];
    let sample = 0;
    let entry = 0;
    for (let chunk = 1; chunk <= chunkCount && sample < sampleCount; chunk++) {
      while (entry + 1 < scCount && u32be(b, stsc.payload + 8 + (entry + 1) * 12) <= chunk) entry++;
      const perChunk = scCount > 0 ? u32be(b, stsc.payload + 8 + entry * 12 + 4) : 0;
      const off = wide ? u64be(b, stco.payload + 8 + (chunk - 1) * 8) : u32be(b, stco.payload + 8 + (chunk - 1) * 4);
      let bytes = 0;
      for (let i = 0; i < perChunk && sample < sampleCount; i++, sample++) bytes += sizeOf.at(sample);
      if (bytes > 0) ranges.push([off, off + bytes]);
    }
    return ranges;
  }

  private sampleSizes(box: Box): { count: number; at: (i: number) => number } {
    const b = this.b;
    const p = box.payload;
    if (p + 12 > box.end) throw new MalformedMediaError(`MP4: ${box.type} too short`);
    const count = u32be(b, p + 8);
    if (box.type === "stsz") {
      const fixed = u32be(b, p + 4);
      if (fixed !== 0) return { count, at: () => fixed };
      if (p + 12 + count * 4 > box.end) throw new MalformedMediaError("MP4: stsz overrun");
      return { count, at: (i) => u32be(b, p + 12 + i * 4) };
    }
    const field = b[p + 7]!;
    if (field !== 4 && field !== 8 && field !== 16) throw new MalformedMediaError("MP4: bad stz2 field size");
    if (p + 12 + Math.ceil((count * field) / 8) > box.end) throw new MalformedMediaError("MP4: stz2 overrun");
    return {
      count,
      at: (i) => {
        if (field === 16) return u16be(b, p + 12 + i * 2);
        if (field === 8) return b[p + 12 + i]!;
        const byte = b[p + 12 + (i >> 1)]!;
        return i & 1 ? byte & 0x0f : byte >> 4;
      },
    };
  }

  /** Zeroes the samples of dropped tracks: only inside mdat payloads, never bytes a kept track uses. */
  private zeroDroppedSamples(): void {
    const keep = [...this.keepRanges].sort((x, y) => x[0] - y[0]);
    for (const [ds, de] of this.dropRanges) {
      for (const [ms, me] of this.mdatPayloads) {
        let s = Math.max(ds, ms);
        const e = Math.min(de, me);
        if (s >= e) continue;
        for (const [ks, ke] of keep) {
          if (ke <= s) continue;
          if (ks >= e) break;
          if (ks > s) this.zero(s, ks, "mp4:data-track");
          s = Math.max(s, ke);
          if (s >= e) break;
        }
        if (s < e) this.zero(s, e, "mp4:data-track");
      }
    }
  }
}

/** Removes metadata from an MP4/MOV/3GP file. See the comment at the top of this file for what changes. */
export function stripBmff(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  const trailer = new Walker(out, true).run();
  return trailer < out.length ? out.slice(0, trailer) : out;
}

export function findBmffMetadata(bytes: Uint8Array): string[] {
  const w = new Walker(bytes, false);
  w.run();
  return [...w.found];
}
