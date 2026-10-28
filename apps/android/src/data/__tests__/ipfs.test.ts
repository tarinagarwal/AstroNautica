import { sha256 } from "@noble/hashes/sha2.js";
import {
  BlockCache,
  CODEC_DAG_PB,
  CODEC_RAW,
  base32Decode,
  base32Encode,
  fetchFileByCid,
  fetchIpfsPath,
  parseCid,
  rawCidOf,
  writeVarint,
  type BlockReport,
  type BlockSource,
} from "../ipfs";

const blocks = new Map<string, Uint8Array>();
const cid = (codec: number, b: Uint8Array) => {
  const s = "b" + base32Encode(Uint8Array.from([1, ...writeVarint(codec), 0x12, 32, ...sha256(b)]));
  blocks.set(s, b);
  return s;
};
const field = (n: number, w: number) => writeVarint((n << 3) | w);
const len = (n: number, b: Uint8Array) => Uint8Array.from([...field(n, 2), ...writeVarint(b.length), ...b]);
const vint = (n: number, v: number) => Uint8Array.from([...field(n, 0), ...writeVarint(v)]);
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const link = (c: string, name: string, size: number) =>
  len(2, cat(len(1, base32Decode(c.slice(1))), len(2, new TextEncoder().encode(name)), vint(3, size)));

const a = Uint8Array.from({ length: 4000 }, (_, i) => i & 255);
const b = Uint8Array.from({ length: 900 }, (_, i) => (i * 3) & 255);
const la = cid(CODEC_RAW, a);
const lb = cid(CODEC_RAW, b);
const file = cid(CODEC_DAG_PB, cat(link(la, "", 4000), link(lb, "", 900), len(1, cat(vint(1, 2), vint(3, 4900)))));
const pl = cid(CODEC_RAW, new TextEncoder().encode("#EXTM3U\n"));
const dir = cid(CODEC_DAG_PB, cat(link(pl, "master.m3u8", 8), link(file, "seg.ts", 4900), len(1, vint(1, 1))));

function source(tamper: Set<string>, reports: BlockReport[] = []): BlockSource {
  return {
    gateways: () => ["https://evil.example", "https://good.example"],
    fetch: async (url) => {
      const u = new URL(url);
      const c = u.pathname.split("/")[2]!;
      const body = blocks.get(c);
      if (!body) return { status: 404, body: new Uint8Array(0) };
      return { status: 200, body: tamper.has(u.origin) ? Uint8Array.from(body, (x, i) => (i ? x : x ^ 1)) : body };
    },
    noCache: true,
    onReport: (r) => reports.push(r),
  };
}

describe("trustless IPFS", () => {
  it("parses CIDs and computes raw-leaf CIDs like Kubo", () => {
    expect(parseCid(file).string).toBe(file);
    expect(rawCidOf(new TextEncoder().encode("hello"))).toBe("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
    expect(() => parseCid("Qm123")).toThrow();
  });

  it("rebuilds files block by block, skipping a gateway that serves wrong bytes", async () => {
    const reports: BlockReport[] = [];
    expect(await fetchFileByCid(file, source(new Set(["https://evil.example"]), reports))).toEqual(cat(a, b));
    expect(reports.some((r) => r.reason === "mismatch" && r.base === "https://evil.example")).toBe(true);
    await expect(fetchFileByCid(file, source(new Set(["https://evil.example", "https://good.example"])))).rejects.toThrow(/verified block/);
  });

  it("resolves paths through directories and enforces size limits", async () => {
    expect(new TextDecoder().decode(await fetchIpfsPath(`${dir}/master.m3u8`, source(new Set())))).toBe("#EXTM3U\n");
    expect(await fetchIpfsPath(`/ipfs/${dir}/seg.ts`, source(new Set()))).toEqual(cat(a, b));
    await expect(fetchIpfsPath(`${dir}/missing`, source(new Set()))).rejects.toThrow(/not found/);
    await expect(fetchFileByCid(file, source(new Set()), 1000)).rejects.toThrow(/too large/);
  });

  it("caches verified blocks with an LRU bound", () => {
    const c = new BlockCache(10);
    c.set("a", new Uint8Array(6));
    c.set("b", new Uint8Array(6));
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeDefined();
  });
});
