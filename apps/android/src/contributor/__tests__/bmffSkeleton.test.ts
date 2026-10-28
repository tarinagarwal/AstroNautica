import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findMetadata, stripMetadata } from "@azaadawaaz/media-strip";
import { INLINE_LIMIT, buildSkeleton, planVideoStrip, verifyVideoStrip, type RandomAccessFile } from "../bmffSkeleton";

const FIX = resolve(__dirname, "../../../../../packages/media-strip/test/fixtures");
const mem = (b: Uint8Array): RandomAccessFile => ({ size: b.length, read: async (o, l) => b.slice(o, o + l) });

function apply(b: Uint8Array, plan: Awaited<ReturnType<typeof planVideoStrip>>): Uint8Array {
  const out = b.slice();
  for (const p of plan.patches) {
    if (p.zero) out.fill(0, p.offset, p.offset + p.zero);
    else out.set(p.data!, p.offset);
  }
  return plan.truncate !== undefined ? out.slice(0, plan.truncate) : out;
}

const fixtures: [string, string][] = [
  ["phone.mp4", "video/mp4"],
  ["phone.mov", "video/quicktime"],
  ["phone-moovlast.mp4", "video/mp4"],
  ["fragmented.mp4", "video/mp4"],
  ["subtitled.mp4", "video/mp4"],
];

describe("large-video stripping through a skeleton (media-strip unchanged)", () => {
  it.each(fixtures)("%s: patched file equals media-strip on the whole file", async (name, mime) => {
    const b = new Uint8Array(readFileSync(resolve(FIX, name)));
    const plan = await planVideoStrip(mem(b), mime);
    expect(plan.removed.length).toBeGreaterThan(0);
    const patched = apply(b, plan);
    expect(Buffer.from(patched).equals(Buffer.from(stripMetadata(b, mime, { keepIcc: false })))).toBe(true);
    expect(findMetadata(patched, mime)).toEqual([]);
    expect(await verifyVideoStrip(mem(patched), mime, plan.zeroed)).toEqual([]);
    // the skeleton really leaves the media data out
    const sk = await buildSkeleton(mem(b));
    expect(sk.bytes.length).toBeLessThan(b.length);
  });

  it("zeroes the samples of dropped data tracks (subtitles/telemetry) inside mdat", async () => {
    const b = new Uint8Array(readFileSync(resolve(FIX, "subtitled.mp4")));
    const plan = await planVideoStrip(mem(b), "video/mp4");
    expect(plan.removed).toContain("mp4:data-track");
    expect(plan.zeroed.length).toBeGreaterThan(0);
    // the verifier notices if those samples were not zeroed
    const partial = apply(b, { ...plan, patches: plan.patches.filter((p) => !p.zero) });
    expect(await verifyVideoStrip(mem(partial), "video/mp4", plan.zeroed)).toContain("mp4:data-track");
  });

  it("rewrites very large removable boxes directly instead of loading them", async () => {
    const base = new Uint8Array(readFileSync(resolve(FIX, "phone.mp4")));
    const size = INLINE_LIMIT + 1024;
    const big = new Uint8Array(size);
    new DataView(big.buffer).setUint32(0, size);
    big.set([0x75, 0x75, 0x69, 0x64], 4); // "uuid"
    big.fill(7, 8 + 16);
    const b = new Uint8Array(base.length + size);
    b.set(base);
    b.set(big, base.length);
    const plan = await planVideoStrip(mem(b), "video/mp4");
    const patched = apply(b, plan);
    expect(Buffer.from(patched).equals(Buffer.from(stripMetadata(b, "video/mp4", { keepIcc: false })))).toBe(true);
    expect(await verifyVideoStrip(mem(patched), "video/mp4", plan.zeroed)).toEqual([]);
  });
});
