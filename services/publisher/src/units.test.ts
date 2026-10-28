import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinningClient } from "./ipfs.js";
import { createVideoTorrent } from "./torrent.js";

describe("pinning service client (IPFS Pinning Service API)", () => {
  it("pins with bearer auth and origins, and reads status", async () => {
    const seen: { auth?: string; body?: any; path?: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined, path: req.url });
        res.setHeader("Content-Type", "application/json");
        if (req.headers.authorization !== "Bearer secret") {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: { reason: "UNAUTHORIZED" } }));
        }
        if (req.method === "POST" && req.url === "/v1/pins") {
          res.statusCode = 202;
          return res.end(JSON.stringify({ requestid: "r1", status: "queued", pin: {} }));
        }
        if (req.method === "GET" && req.url === "/v1/pins/r1") return res.end(JSON.stringify({ requestid: "r1", status: "pinned" }));
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = new PinningClient({ name: "test", endpoint: `http://127.0.0.1:${port}/v1/`, token: "secret" });
    const p = await client.pin("bafyabc", "azaad:story:1", ["/ip4/1.2.3.4/tcp/4001/p2p/Qm"]);
    expect(p).toEqual({ service: "test", requestid: "r1", status: "queued" });
    expect(seen[0]!.body).toEqual({ cid: "bafyabc", name: "azaad:story:1", origins: ["/ip4/1.2.3.4/tcp/4001/p2p/Qm"] });
    expect((await client.status("r1")).status).toBe("pinned");

    const bad = new PinningClient({ name: "bad", endpoint: `http://127.0.0.1:${port}/v1`, token: "wrong" });
    expect((await bad.pin("bafyabc", "n", [])).status).toBe("error");
    const down = new PinningClient({ name: "down", endpoint: "http://127.0.0.1:1/v1", token: "x" });
    expect((await down.pin("bafyabc", "n", [])).status).toBe("error");
    server.close();
  });
});

describe("video torrents", () => {
  it("creates a deterministic torrent with web seeds and files in the seed dir", async () => {
    const files = [
      { path: "video.mp4", content: new Uint8Array(100_000).fill(7) },
      { path: "hls/master.m3u8", content: new TextEncoder().encode("#EXTM3U\n") },
    ];
    const webSeeds = ["https://gw.example/ipfs/bafydir/"];
    const a = await createVideoTorrent({ name: "story-x", files, webSeeds, seedDir: mkdtempSync(join(tmpdir(), "seed-")) });
    const seedDir = mkdtempSync(join(tmpdir(), "seed-"));
    const b = await createVideoTorrent({ name: "story-x", files, webSeeds, seedDir });
    expect(a.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(b.infoHash).toBe(a.infoHash);
    expect(b.magnet).toContain(`xt=urn:btih:${a.infoHash}`);
    expect(decodeURIComponent(b.magnet)).toContain("ws=https://gw.example/ipfs/bafydir/");
    expect(existsSync(join(seedDir, "story-x", "hls", "master.m3u8"))).toBe(true);
    expect(readFileSync(b.torrentPath).includes(Buffer.from("8:url-list"))).toBe(true);
  });
});
