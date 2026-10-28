import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectMime, findMetadata } from "@azaadawaaz/media-strip";
import { MediaInputError, processVideo, selectLadder, sha256Hex, type ProcessedVideo } from "../src/index.js";
import {
  contains,
  decodeAll,
  ffmpeg,
  ffprobe,
  HAS_FFMPEG,
  makeVideo,
  MEDIA_STRIP_FIXTURES,
  tempDir,
} from "./helpers.js";

describe("selectLadder", () => {
  it("never goes above the source's short side", () => {
    expect(selectLadder(1920, 1080).map((r) => r.name)).toEqual(["360p", "720p", "1080p"]);
    expect(selectLadder(1280, 720).map((r) => r.name)).toEqual(["360p", "720p"]);
    expect(selectLadder(1000, 700).map((r) => [r.width, r.height])).toEqual([[514, 360]]);
    expect(selectLadder(3840, 2160, [720, 360]).map((r) => r.p)).toEqual([360, 720]);
  });

  it("uses the short side for portrait video", () => {
    expect(selectLadder(1080, 1920).map((r) => [r.name, r.width, r.height])).toEqual([
      ["360p", 360, 640],
      ["720p", 720, 1280],
      ["1080p", 1080, 1920],
    ]);
  });

  it("gives a source below 360p one rendition at its own size", () => {
    expect(selectLadder(320, 240)).toEqual([{ name: "240p", p: 240, width: 320, height: 240, videoKbps: 533 }]);
    expect(selectLadder(161, 121)[0]).toMatchObject({ name: "120p", width: 160, height: 120 });
  });
});

/**
 * Tags an output may carry: container brands, zeroed vendor, language, the MPEG-TS service we name, and
 * variant_bitrate (computed by ffmpeg's HLS demuxer from master.m3u8, not stored metadata).
 */
const ALLOWED_TAGS = new Set([
  "major_brand",
  "minor_version",
  "compatible_brands",
  "language",
  "vendor_id",
  "variant_bitrate",
]);

function checkNoTags(path: string, extra: string[] = []): void {
  const p = ffprobe(path, extra);
  for (const k of Object.keys(p.format.tags ?? {})) expect(ALLOWED_TAGS, `${path}: format tag ${k}`).toContain(k);
  for (const s of p.streams) {
    for (const [k, v] of Object.entries(s.tags ?? {})) {
      expect(ALLOWED_TAGS, `${path}: stream tag ${k}=${v}`).toContain(k);
      if (k === "vendor_id") expect(v).toBe("[0][0][0][0]");
    }
  }
  for (const prog of p.programs ?? []) {
    const { variant_bitrate: _bitrate, ...tags } = prog.tags ?? {};
    if (Object.keys(tags).length) expect(tags).toEqual({ service_name: "AzaadAwaaz", service_provider: "AzaadAwaaz" });
  }
}

function playlistEntries(path: string): { uri: string; duration?: number; resolution?: string }[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: { uri: string; duration?: number; resolution?: string }[] = [];
  let pending: { duration?: number; resolution?: string } = {};
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) pending.duration = Number(line.slice(8).split(",")[0]);
    else if (line.startsWith("#EXT-X-STREAM-INF:")) pending.resolution = /RESOLUTION=(\d+x\d+)/.exec(line)?.[1];
    else if (line && !line.startsWith("#")) {
      out.push({ uri: line, ...pending });
      pending = {};
    }
  }
  return out;
}

function topLevelTypes(b: Uint8Array): string[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const types: string[] = [];
  for (let pos = 0; pos + 8 <= b.length;) {
    const size = v.getUint32(pos);
    types.push(String.fromCharCode(...b.subarray(pos + 4, pos + 8)));
    if (size < 8) break;
    pos += size;
  }
  return types;
}

const SECRETS = ["Samsung", "SM-G991B", "28.6139", "Lavf", "Lavc", "x264 - core", "iPhone", "Jane"];

describe.skipIf(!HAS_FFMPEG)("processVideo", () => {
  let dir: string;
  const results = new Map<string, ProcessedVideo>();

  beforeAll(async () => {
    dir = tempDir();
    const sources = {
      hd: makeVideo(join(dir, "hd.mp4"), { width: 1280, height: 720, seconds: 9, audio: true }),
      fullhd: makeVideo(join(dir, "fullhd.mp4"), { width: 1920, height: 1080, seconds: 2, audio: true }),
      small: makeVideo(join(dir, "small.mp4"), { width: 320, height: 240, seconds: 1.5 }),
    };
    // Portrait as phones record it: landscape pixels plus a 90° rotation in the track matrix.
    const landscape = makeVideo(join(dir, "rot-src.mp4"), { width: 640, height: 360, seconds: 2, audio: true });
    ffmpeg(["-display_rotation:v:0", "90", "-i", landscape, "-c", "copy", join(dir, "portrait.mp4")]);
    const all: Record<string, string> = {
      ...sources,
      portrait: join(dir, "portrait.mp4"),
      mov: new URL("phone.mov", MEDIA_STRIP_FIXTURES).pathname,
    };
    for (const [name, path] of Object.entries(all))
      results.set(name, await processVideo(path, join(dir, `out-${name}`)));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("builds the HLS ladder only up to the source height, with a relative master playlist", () => {
    const expected: Record<string, string[]> = {
      hd: ["640x360", "1280x720"],
      fullhd: ["640x360", "1280x720", "1920x1080"],
      small: ["320x240"],
      portrait: ["360x640"],
      mov: ["160x120"],
    };
    for (const [name, resolutions] of Object.entries(expected)) {
      const r = results.get(name)!;
      const master = playlistEntries(join(r.hlsDir, "master.m3u8"));
      expect(
        master.map((e) => e.resolution),
        name,
      ).toEqual(resolutions);
      for (const e of master) {
        expect(e.uri).toMatch(/^\d+p\/index\.m3u8$/);
        const variant = join(r.hlsDir, e.uri);
        const segments = playlistEntries(variant);
        expect(segments.length).toBeGreaterThan(0);
        for (const s of segments) {
          expect(s.uri).toMatch(/^seg_\d{3}\.ts$/);
          expect(existsSync(join(r.hlsDir, e.uri, "..", s.uri))).toBe(true);
        }
        // 4 s segments (the last one may be shorter); never more than 6 s.
        for (const s of segments.slice(0, -1)) {
          expect(s.duration!).toBeGreaterThanOrEqual(4);
          expect(s.duration!).toBeLessThanOrEqual(6);
        }
        expect(segments[segments.length - 1]!.duration!).toBeLessThanOrEqual(6);
        const [w, h] = e.resolution!.split("x").map(Number);
        const p = ffprobe(join(r.hlsDir, e.uri, "..", segments[0]!.uri));
        const v = p.streams.find((s) => s.codec_type === "video")!;
        expect([v.codec_name, v.width, v.height]).toEqual(["h264", w, h]);
        const a = p.streams.find((s) => s.codec_type === "audio");
        expect(a?.codec_name).toBe(name === "small" || name === "mov" ? undefined : "aac");
      }
    }
    expect(playlistEntries(join(results.get("hd")!.hlsDir, "720p/index.m3u8")).map((s) => s.duration)).toEqual([
      4, 4, 1,
    ]);
  });

  it("plays the HLS folder from disk and the MP4s decode completely", () => {
    for (const r of results.values()) {
      decodeAll(join(r.hlsDir, "master.m3u8"), ["-protocol_whitelist", "file"]);
      decodeAll(r.mp4.path);
      decodeAll(r.preview.path);
      decodeAll(r.poster.path);
    }
  });

  it("reports duration and display size from ffprobe", () => {
    expect(results.get("hd")).toMatchObject({ durationSec: 9, width: 1280, height: 720 });
    expect(results.get("fullhd")).toMatchObject({ durationSec: 2, width: 1920, height: 1080 });
    expect(results.get("small")).toMatchObject({ width: 320, height: 240 });
    expect(results.get("small")!.durationSec).toBeCloseTo(1.5, 1);
    expect(results.get("portrait")).toMatchObject({ width: 360, height: 640 });
  });

  it("makes a 720p (or smaller) faststart MP4 fallback, a poster from 10% in and a muted ≤ 6 s preview", () => {
    const fallback: Record<string, [number, number]> = {
      hd: [1280, 720],
      fullhd: [1280, 720],
      small: [320, 240],
      portrait: [360, 640],
    };
    for (const [name, [w, h]] of Object.entries(fallback)) {
      const r = results.get(name)!;
      const mp4 = ffprobe(r.mp4.path);
      const v = mp4.streams.find((s) => s.codec_type === "video")!;
      expect([v.codec_name, v.width, v.height], name).toEqual(["h264", w, h]);
      expect(v.side_data_list ?? []).toEqual([]); // rotation applied to the pixels, no display matrix left
      const bytes = new Uint8Array(readFileSync(r.mp4.path));
      const top = topLevelTypes(bytes);
      expect(top.indexOf("moov"), name).toBeLessThan(top.indexOf("mdat")); // faststart
      expect(r.mp4.sha256).toBe(sha256Hex(bytes));

      const preview = ffprobe(r.preview.path);
      expect(preview.streams.map((s) => s.codec_type)).toEqual(["video"]);
      expect(Number(preview.format.duration)).toBeLessThanOrEqual(6.05);
      const pv = preview.streams[0]!;
      expect(Math.min(pv.width!, pv.height!)).toBeLessThanOrEqual(360);

      const poster = new Uint8Array(readFileSync(r.poster.path));
      expect(detectMime(poster)).toBe("image/jpeg");
      const pp = ffprobe(r.poster.path).streams[0]!;
      expect([pp.width, pp.height]).toEqual([r.poster.width, r.poster.height]);
      expect(r.poster.sha256).toBe(sha256Hex(poster));
    }
    expect(Number(ffprobe(results.get("hd")!.preview.path).format.duration)).toBeCloseTo(6, 1);
    expect(ffprobe(results.get("hd")!.mp4.path).streams.map((s) => s.codec_type)).toEqual(["video", "audio"]);
  });

  it("carries no source metadata into any output", () => {
    for (const [name, r] of results) {
      // media-strip finds nothing in the MP4s and the poster.
      for (const p of [r.mp4.path, r.preview.path, r.poster.path]) {
        expect(findMetadata(new Uint8Array(readFileSync(p))), `${name} ${p}`).toEqual([]);
      }
      // ffprobe shows no tags beyond container brands / zeroed vendor / our MPEG-TS service name.
      checkNoTags(r.mp4.path);
      checkNoTags(r.preview.path);
      checkNoTags(join(r.hlsDir, "master.m3u8"), ["-protocol_whitelist", "file"]);
      const files = [r.mp4.path, r.preview.path, r.poster.path];
      for (const d of readdirSync(r.hlsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const f of readdirSync(join(r.hlsDir, d.name))) {
          files.push(join(r.hlsDir, d.name, f));
          if (f.endsWith(".ts")) checkNoTags(join(r.hlsDir, d.name, f));
        }
      }
      for (const f of files) {
        const bytes = new Uint8Array(readFileSync(f));
        for (const secret of SECRETS) expect(contains(bytes, secret), `${f} contains ${secret}`).toBe(false);
      }
    }
  });

  it("refuses inputs over the limits and anything that is not MP4/MOV/WebM", async () => {
    const hd = join(dir, "hd.mp4");
    await expect(processVideo(hd, join(dir, "x1"), { limits: { maxVideoDurationSec: 5 } })).rejects.toThrow(
      /limit is 5 s/,
    );
    await expect(processVideo(hd, join(dir, "x2"), { limits: { maxVideoBytes: 1000 } })).rejects.toThrow(
      MediaInputError,
    );
    // An HLS playlist renamed to .mp4 would let ffmpeg read other local files; it never reaches ffmpeg.
    const playlist = join(dir, "evil.mp4");
    writeFileSync(playlist, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n");
    await expect(processVideo(playlist, join(dir, "x3"))).rejects.toThrow(/unsupported video container/);
    writeFileSync(join(dir, "empty.mp4"), "");
    await expect(processVideo(join(dir, "empty.mp4"), join(dir, "x4"))).rejects.toThrow(/empty/);
    // A truncated file fails inside the sandboxed ffprobe/ffmpeg, not in our process.
    const truncated = join(dir, "truncated.mp4");
    writeFileSync(truncated, readFileSync(hd).subarray(0, 2000));
    await expect(processVideo(truncated, join(dir, "x5"))).rejects.toThrow();
  });

  it("accepts WebM from browsers", async () => {
    const webm = join(dir, "browser.webm");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=25",
      "-t",
      "1",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      webm,
    ]);
    const r = await processVideo(webm, join(dir, "out-webm"));
    expect(r).toMatchObject({ width: 640, height: 360 });
    expect(playlistEntries(join(r.hlsDir, "master.m3u8")).map((e) => e.resolution)).toEqual(["640x360"]);
  });
});
