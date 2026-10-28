import { describe, expect, it } from "vitest";
import { sha256Hex } from "@azaadawaaz/schema";
import { fetchFileByCid, fetchIpfsPath, parseCid, CODEC_DAG_PB, CODEC_RAW, type BlockSource } from "./ipfs.js";
import { encodeDirectory, encodeFile } from "../test/unixfs-encode.js";
import { makeVerifiedLoader, virtualUrl } from "./hlsLoader.js";

function source(
  gateways: Record<string, Map<string, Uint8Array>>,
  reports: { base: string; reason?: string; ok: boolean }[] = [],
): BlockSource {
  return {
    gateways: () => Object.keys(gateways),
    fetch: async (url) => {
      const u = new URL(url);
      const cid = u.pathname.replace("/ipfs/", "");
      const b = gateways[u.origin]?.get(cid);
      return b ? new Response(b as BodyInit) : new Response("nope", { status: 404 });
    },
    noCache: true,
    onReport: (r) => reports.push(r),
  };
}

const blocksOf = (e: { blocks: { cid: string; bytes: Uint8Array }[] }) =>
  new Map(e.blocks.map((b) => [b.cid, b.bytes]));

describe("trustless IPFS", () => {
  it("parses CIDv1 raw and dag-pb", () => {
    const small = encodeFile(new Uint8Array([1, 2, 3]));
    expect(parseCid(small.cid).codec).toBe(CODEC_RAW);
    const big = encodeFile(new Uint8Array(300 * 1024).fill(7));
    expect(parseCid(big.cid).codec).toBe(CODEC_DAG_PB);
    expect(small.cid.startsWith("bafkrei")).toBe(true);
    expect(big.cid.startsWith("bafybei")).toBe(true);
  });

  it("reassembles a chunked file, verifying every block", async () => {
    const data = new Uint8Array(700 * 1024).map((_, i) => i % 251);
    const e = encodeFile(data);
    const out = await fetchFileByCid(e.cid, source({ "http://a.test": blocksOf(e) }));
    expect(sha256Hex(out)).toBe(sha256Hex(data));
  });

  it("rejects a block with wrong bytes, flags that gateway and uses the next", async () => {
    const data = new TextEncoder().encode("the real story");
    const e = encodeFile(data);
    const lying = new Map([[e.cid, new TextEncoder().encode("a fake story")]]);
    const reports: { base: string; reason?: string; ok: boolean }[] = [];
    const out = await fetchFileByCid(
      e.cid,
      source({ "http://liar.test": lying, "http://good.test": blocksOf(e) }, reports),
    );
    expect(new TextDecoder().decode(out)).toBe("the real story");
    expect(reports).toContainEqual(
      expect.objectContaining({ base: "http://liar.test", ok: false, reason: "mismatch" }),
    );
  });

  it("fails when no gateway has matching bytes", async () => {
    const e = encodeFile(new TextEncoder().encode("x"));
    await expect(
      fetchFileByCid(e.cid, source({ "http://liar.test": new Map([[e.cid, new Uint8Array([9])]]) })),
    ).rejects.toThrow();
  });

  it("resolves directory paths (HLS folders) through verified blocks", async () => {
    const dir = encodeDirectory({
      "master.m3u8": new TextEncoder().encode("#EXTM3U"),
      "720p": { "seg0.ts": new Uint8Array(400 * 1024).fill(3) },
    });
    const src = source({ "http://a.test": blocksOf(dir) });
    expect(new TextDecoder().decode(await fetchIpfsPath(`${dir.cid}/master.m3u8`, src))).toBe("#EXTM3U");
    expect((await fetchIpfsPath(`/ipfs/${dir.cid}/720p/seg0.ts`, src)).length).toBe(400 * 1024);
    await expect(fetchIpfsPath(`${dir.cid}/missing.ts`, src)).rejects.toThrow(/not found/);
  });

  it("the hls.js loader serves playlists as text and segments as ArrayBuffers via verified paths", async () => {
    const dir = encodeDirectory({
      "master.m3u8": new TextEncoder().encode("#EXTM3U\n"),
      "a.ts": new Uint8Array([1, 2, 3, 4]),
    });
    const src = source({ "http://a.test": blocksOf(dir) });
    const Loader = makeVerifiedLoader((p) => fetchIpfsPath(p, src));
    const load = (url: string, responseType: "" | "arraybuffer") =>
      new Promise<unknown>((resolve, reject) => {
        new Loader({}).load({ url, responseType } as never, {} as never, {
          onSuccess: (r) => resolve(r.data),
          onError: (e) => reject(new Error(e.text)),
          onTimeout: () => reject(new Error("timeout")),
        });
      });
    expect(await load(virtualUrl(`${dir.cid}/master.m3u8`), "")).toBe("#EXTM3U\n");
    const seg = (await load(new URL("a.ts", virtualUrl(`${dir.cid}/master.m3u8`)).href, "arraybuffer")) as ArrayBuffer;
    expect([...new Uint8Array(seg)]).toEqual([1, 2, 3, 4]);
    await expect(load("https://evil.example/x.ts", "arraybuffer")).rejects.toThrow(/only IPFS/);
  });
});
