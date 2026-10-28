/**
 * The e2e environment: a real strfry relay (Docker, port 7791), a small HTTP server acting as IPFS gateway (raw
 * blocks and files), Arweave gateway and chain JSON-RPC (port 7792), a mock API (port 7793), and the production
 * build of the app (localnet CSP) served by `vite preview` (port 4791). Signed sample stories are published to the
 * relay with the real core functions.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { RelayPool, createListEvent, type Event } from "@azaadawaaz/core";
import type { VideoBlock } from "@azaadawaaz/schema";
import { build, preview } from "vite";
import {
  arweaveReply,
  createWorld,
  everyBlockStory,
  gatewayReply,
  publishStory,
  rpcReply,
  textStory,
  type HttpReply,
  type VideoAssets,
} from "../src/test/world.js";
import { mockApi } from "../src/test/mockApi.js";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const repo = resolve(web, "../..");
const out = join(web, "test-results/e2e");
export const PORTS = { relay: 7791, http: 7792, api: 7793, app: 4791 };
const RELAY = `ws://127.0.0.1:${PORTS.relay}`;
const CONTAINER = "web-test-relay";

function startRelay(): void {
  const conf = readFileSync(join(repo, "infra/relay/strfry.conf"), "utf8")
    .replace(/plugin = "[^"]*"/, 'plugin = ""')
    .replace(/nofiles = \d+/, "nofiles = 0");
  writeFileSync(join(out, "strfry.conf"), conf);
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    // not running
  }
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    `127.0.0.1:${PORTS.relay}:7777`,
    "-v",
    `${join(out, "strfry.conf")}:/etc/strfry.conf:ro`,
    "--tmpfs",
    "/app/strfry-db",
    "dockurr/strfry:latest",
  ]);
}

async function waitForRelay(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise<boolean>((r) => {
      const ws = new WebSocket(RELAY);
      ws.on("open", () => {
        ws.close();
        r(true);
      });
      ws.on("error", () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("relay did not start");
}

function readTree(dir: string): Record<string, Uint8Array | Record<string, Uint8Array>> {
  const outTree: Record<string, Uint8Array | Record<string, Uint8Array>> = {};
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    outTree[f] = statSync(p).isDirectory()
      ? (readTree(p) as Record<string, Uint8Array>)
      : new Uint8Array(readFileSync(p));
  }
  return outTree;
}

/** A real 4-second VP9 HLS stream (fMP4) plus an MP4 fallback and a poster: Chromium builds play VP9, not H.264. */
function makeVideo(): VideoAssets {
  const dir = join(out, "video");
  const hls = join(dir, "hls");
  mkdirSync(join(hls, "360p"), { recursive: true });
  const src = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "4"];
  const vp9 = [
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "250k",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-g",
    "25",
    "-pix_fmt",
    "yuv420p",
  ];
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  ff([
    ...src,
    ...vp9,
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    join(hls, "360p/seg%d.m4s"),
    join(hls, "360p/index.m3u8"),
  ]);
  writeFileSync(
    join(hls, "master.m3u8"),
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,CODECS="vp09.00.30.08"\n360p/index.m3u8\n',
  );
  ff([...src, ...vp9, "-movflags", "+faststart", join(dir, "fallback.mp4")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1", join(dir, "poster.png")]);
  return {
    hls: readTree(hls),
    mp4: new Uint8Array(readFileSync(join(dir, "fallback.mp4"))),
    poster: new Uint8Array(readFileSync(join(dir, "poster.png"))),
  };
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r()));
}

export default async function globalSetup() {
  mkdirSync(out, { recursive: true });
  startRelay();
  const video = makeVideo();
  const urls = {
    relay: RELAY,
    gateway: `http://127.0.0.1:${PORTS.http}`,
    arweave: `http://127.0.0.1:${PORTS.http}/arweave`,
    rpc: `http://127.0.0.1:${PORTS.http}/rpc`,
    api: `http://127.0.0.1:${PORTS.api}`,
  };
  const world = await createWorld(urls);
  const embedded = publishStory(world, textStory(world, "Embedded update", 3000));
  const main = publishStory(world, await everyBlockStory(world, embedded.manifest.id, video));
  const unlisted = publishStory(world, textStory(world, "Unlisted story", 2500));
  const unlist = createListEvent(
    "unlisted",
    [[unlisted.manifest.id, Math.floor(Date.now() / 1000) - 100]],
    world.moderator.secretKey,
  );

  // Gateway + Arweave + RPC on one port; API on another.
  const gw = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", urls.gateway);
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let r: HttpReply;
    if (u.pathname.startsWith("/ipfs/"))
      r = gatewayReply(world, u.pathname, u.searchParams, String(req.headers.accept ?? ""));
    else if (u.pathname.startsWith("/arweave/")) r = arweaveReply(world, u.pathname.slice("/arweave".length));
    else if (u.pathname === "/rpc" && req.method === "POST")
      r = rpcReply(world, (await readBody(req)).toString("utf8"));
    else r = { status: 404, body: "not found" };
    res.writeHead(r.status, { ...cors, "content-type": r.type ?? "text/plain" }).end(Buffer.from(r.body as Uint8Array));
  });
  const api = mockApi(world, urls.api);
  const apiServer = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    const body = await readBody(req);
    const isJson = String(req.headers["content-type"] ?? "").includes("json");
    const r = await api.fetch(urls.api + (req.url ?? "/"), {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: body.length ? (isJson ? body.toString("utf8") : new Uint8Array(body)) : undefined,
    });
    res
      .writeHead(r.status, { ...cors, "content-type": r.headers.get("content-type") ?? "application/json" })
      .end(Buffer.from(await r.arrayBuffer()));
  });
  await listen(gw, PORTS.http);
  await listen(apiServer, PORTS.api);

  await waitForRelay();
  const pool = new RelayPool({ websocketImplementation: WebSocket });
  const events: Event[] = [...world.listEvents, ...world.stories.flatMap((s) => [s.event, s.receipt]), unlist];
  for (const e of events) {
    const r = await pool.publish([RELAY], e);
    if (!r[0]!.ok) throw new Error(`relay rejected event: ${r[0]!.message}`);
  }
  pool.close();

  // Bundle the owner key and lists into a localnet build, like scripts/dev-setup.mjs does for dev.
  const config = {
    ownerPubkey: world.owner.pubkey,
    relays: [RELAY],
    chains: [{ key: "base-local", chainId: 31337, rpc: urls.rpc, registry: world.registry, name: "Base (local)" }],
    apiUrl: urls.api,
    powDifficulty: 12,
  };
  writeFileSync(join(out, "config.json"), JSON.stringify(config));
  writeFileSync(join(out, "list-events.json"), JSON.stringify(world.listEvents));
  execFileSync("node", ["scripts/gen-defaults.mjs"], {
    cwd: web,
    env: {
      ...process.env,
      DEFAULTS_CONFIG: join(out, "config.json"),
      DEFAULTS_LIST_EVENTS: join(out, "list-events.json"),
    },
  });
  await build({ root: web, mode: "localnet", logLevel: "warn", build: { outDir: "dist-e2e", emptyOutDir: true } });
  const server = await preview({
    root: web,
    mode: "localnet",
    build: { outDir: "dist-e2e" },
    preview: { port: PORTS.app, strictPort: true, host: "127.0.0.1" },
  });

  writeFileSync(
    join(out, "world.json"),
    JSON.stringify({
      storyId: main.manifest.id,
      embeddedId: embedded.manifest.id,
      unlistedId: unlisted.manifest.id,
      hlsCid: main.manifest.blocks.find((b): b is VideoBlock => b.type === "video")!.hls.split("/")[0],
      moderatorNsec: world.moderator.nsec,
      moderatorX25519: world.moderatorX.privateKey,
      relay: RELAY,
    }),
  );

  return async () => {
    await server.close();
    gw.close();
    apiServer.close();
    try {
      execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    } catch {
      // already gone
    }
    // Put the developer's defaults back.
    execFileSync("node", ["scripts/gen-defaults.mjs"], { cwd: web, stdio: "ignore" });
  };
}
