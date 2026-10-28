/**
 * A complete, realistic test world built with the real core functions: owner, publisher and moderator keys, the
 * owner-signed lists, a story of every block type with a genuine moderator approval, its manifest as real IPFS
 * blocks, the publisher-signed story event and storage receipt, and a chain receipt. Shared by unit tests and e2e.
 */
import {
  createListEvent,
  createStorageReceiptEvent,
  createStoryEvent,
  generateKeyPair,
  generateEncryptionKeyPair,
  signApproval,
  type EncryptionKeyPair,
  type Event,
  type KeyPair,
} from "@azaadawaaz/core";
import { canonicalize, manifestSha256, sha256Hex, uuidv7, type Manifest } from "@azaadawaaz/schema";
import { encodeDirectory, encodeFile, type Block } from "./unixfs-encode.js";
import { PUBLISHED_TOPIC, RECEIPT_SELECTOR, storyTopic } from "../lib/eth.js";

export interface WorldUrls {
  relay: string;
  gateway: string;
  arweave: string;
  rpc: string;
  api?: string;
}

export interface StoryBundle {
  manifest: Manifest;
  bytes: Uint8Array;
  sha256: string;
  cid: string;
  event: Event;
  receipt: Event;
  arweaveTx: string;
}

export interface World {
  owner: KeyPair;
  ownerX: EncryptionKeyPair;
  publisher: KeyPair;
  publisherX: EncryptionKeyPair;
  moderator: KeyPair;
  moderatorX: EncryptionKeyPair;
  listEvents: Event[];
  urls: WorldUrls;
  /** IPFS blocks by CID (raw block bytes). */
  blocks: Map<string, Uint8Array>;
  /** File contents by CID or CID/path, for plain gateway requests. */
  files: Map<string, Uint8Array>;
  /** Arweave transactions. */
  arweave: Map<string, Uint8Array>;
  /** Chain receipts: storyId:version → { sha, cid, timestamp, tx, block }. */
  receipts: Map<string, { sha: string; cid: string; timestamp: number; tx: string; block: number }>;
  registry: string;
  chainId: number;
  stories: StoryBundle[];
}

const enc = new TextEncoder();

/** A tiny valid PNG of one colour (so e2e screenshots show real images). */
export async function solidPng(w: number, h: number, rgb: [number, number, number]): Promise<Uint8Array> {
  const { deflateSync } = await import("node:zlib");
  const row = new Uint8Array(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * h);
  for (let y = 0; y < h; y++) raw.set(row, y * row.length);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(enc.encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function addBlocks(world: World, blocks: Block[]) {
  for (const b of blocks) world.blocks.set(b.cid, b.bytes);
}

function addFile(world: World, bytes: Uint8Array): { cid: string; sha256: string } {
  const e = encodeFile(bytes);
  addBlocks(world, e.blocks);
  world.files.set(e.cid, bytes);
  return { cid: e.cid, sha256: sha256Hex(bytes) };
}

const txId = (seed: string) =>
  sha256Hex(seed)
    .slice(0, 43)
    .replace(/[^A-Za-z0-9_-]/g, "a");

export async function createWorld(urls: WorldUrls): Promise<World> {
  const world: World = {
    owner: generateKeyPair(),
    ownerX: await generateEncryptionKeyPair(),
    publisher: generateKeyPair(),
    publisherX: await generateEncryptionKeyPair(),
    moderator: generateKeyPair(),
    moderatorX: await generateEncryptionKeyPair(),
    listEvents: [],
    urls,
    blocks: new Map(),
    files: new Map(),
    arweave: new Map(),
    receipts: new Map(),
    registry: "0x" + "5f".repeat(20),
    chainId: 31337,
    stories: [],
  };
  const t0 = Math.floor(Date.now() / 1000) - 3600;
  world.listEvents = [
    createListEvent(
      "moderators",
      [{ pubkey: world.moderator.pubkey, x25519: world.moderatorX.publicKey, from: 0, name: "Test moderator" }],
      world.owner.secretKey,
      t0,
    ),
    createListEvent(
      "service-keys",
      [
        { role: "owner", pubkey: world.owner.pubkey, x25519: world.ownerX.publicKey, from: 0 },
        { role: "publisher", pubkey: world.publisher.pubkey, x25519: world.publisherX.publicKey, from: 0 },
      ],
      world.owner.secretKey,
      t0,
    ),
    createListEvent("relays", [{ url: urls.relay, operator: "own" }], world.owner.secretKey, t0),
    createListEvent(
      "gateways",
      [
        { url: urls.gateway, network: "ipfs", operator: "own" },
        { url: urls.arweave, network: "arweave", operator: "own" },
      ],
      world.owner.secretKey,
      t0,
    ),
    createListEvent(
      "mirrors",
      [{ url: "https://azaadawaaz.example" }, { url: "https://t.me/azaadawaaz_test" }],
      world.owner.secretKey,
      t0,
    ),
    createListEvent("onions", [{ address: "azaad" + "a".repeat(51) + ".onion" }], world.owner.secretKey, t0),
  ];
  return world;
}

/** Sign, store and register a story: manifest on IPFS + Arweave, story event, storage receipt, chain receipt. */
export function publishStory(world: World, m: Manifest, createdAt = Math.floor(Date.now() / 1000) - 600): StoryBundle {
  m.approval = signApproval(m, world.moderator.secretKey, m.approval.approvedAt);
  const bytes = enc.encode(canonicalize(m));
  const sha = manifestSha256(m);
  const { cid } = addFile(world, bytes);
  const arweaveTx = txId("ar:" + sha);
  world.arweave.set(arweaveTx, bytes);
  const event = createStoryEvent({ manifest: m, manifestCid: cid, secretKey: world.publisher.secretKey, createdAt });
  const receipt = createStorageReceiptEvent(
    { storyId: m.id, version: m.version, manifestSha256: sha, arweave: { [sha]: arweaveTx } },
    world.publisher.secretKey,
    createdAt + 30,
  );
  world.receipts.set(`${m.id}:${m.version}`, {
    sha,
    cid,
    timestamp: createdAt + 60,
    tx: "0x" + sha256Hex("tx:" + sha),
    block: 100 + world.receipts.size,
  });
  const bundle = { manifest: m, bytes, sha256: sha, cid, event, receipt, arweaveTx };
  world.stories.push(bundle);
  return bundle;
}

const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A bilingual story with every block type: text, gallery, single image, video (HLS + MP4) and an embedded story. */
export interface VideoAssets {
  /** HLS folder: master.m3u8 plus rendition folders. */
  hls: Record<string, Uint8Array | Record<string, Uint8Array>>;
  mp4: Uint8Array;
  poster: Uint8Array;
}

export async function everyBlockStory(world: World, embedId: string, video?: VideoAssets): Promise<Manifest> {
  const npub = (k: KeyPair) => k.npub;
  const img1 = addFile(world, await solidPng(64, 36, [180, 35, 42]));
  const img2 = addFile(world, await solidPng(48, 48, [30, 110, 170]));
  const img3 = addFile(world, await solidPng(40, 30, [40, 140, 70]));
  const variant = addFile(world, await solidPng(32, 18, [180, 35, 42]));
  const poster = addFile(world, video?.poster ?? (await solidPng(64, 36, [20, 20, 20])));
  const mp4 = addFile(world, video?.mp4 ?? enc.encode("not really an mp4 but hashed and verified like one"));
  // An HLS folder as a real UnixFS directory: master playlist, one rendition, two segments.
  const seg = (n: number) => enc.encode(`segment ${n} `.repeat(200));
  const hls = encodeDirectory(
    video?.hls ?? {
      "master.m3u8": enc.encode("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360\n360p/index.m3u8\n"),
      "360p": {
        "index.m3u8": enc.encode(
          "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n",
        ),
        "seg0.ts": seg(0),
        "seg1.ts": seg(1),
      },
    },
  );
  addBlocks(world, hls.blocks);
  const now = Math.floor(Date.now() / 1000) - 900;
  return {
    schema: "azaadawaaz/story@1",
    id: uuidv7(now * 1000),
    version: 1,
    supersedes: null,
    language: "both",
    title: { en: "Floods in the valley", hi: "घाटी में बाढ़" },
    summary: { en: "What residents saw as the river rose overnight.", hi: "रात भर नदी चढ़ने पर लोगों ने क्या देखा।" },
    cover: {
      sha256: img1.sha256,
      cid: img1.cid,
      width: 64,
      height: 36,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      variants: { "480": variant.cid },
    },
    tags: ["floods", "valley"],
    location: { en: "Upper valley", hi: "ऊपरी घाटी" },
    contributor: { pubkey: npub(world.moderator), displayName: "Field reporter" },
    blocks: [
      {
        type: "text",
        markdown: {
          en: "## Morning\nThe water rose **two metres** before dawn.\n\n> We moved to the school roof.\n\n- Bridge closed\n- Power out\n\n[Relief line](https://example.org/relief)\n\n<script>alert(1)</script>",
          hi: "## सुबह\nभोर से पहले पानी **दो मीटर** चढ़ गया।\n\n> हम स्कूल की छत पर चले गए।",
        },
      },
      {
        type: "image",
        items: [
          {
            sha256: img1.sha256,
            cid: img1.cid,
            width: 64,
            height: 36,
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
            caption: { en: "The bridge", hi: "पुल" },
            variants: { "480": variant.cid },
          },
          {
            sha256: img2.sha256,
            cid: img2.cid,
            width: 48,
            height: 48,
            blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
            caption: { en: "The market", hi: "बाज़ार" },
          },
        ],
      },
      {
        type: "image",
        items: [
          { sha256: img3.sha256, cid: img3.cid, width: 40, height: 30, blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH" },
        ],
      },
      {
        type: "video",
        source: { sha256: sha256Hex("original upload") },
        title: { en: "Interview", hi: "साक्षात्कार" },
        description: { en: "A resident describes the night.", hi: "एक निवासी रात के बारे में बताते हैं।" },
        hls: `${hls.cid}/master.m3u8`,
        mp4,
        poster,
        durationSec: 8,
      },
      { type: "embed-story", storyId: embedId },
    ],
    approval: { moderator: npub(world.moderator), approvedAt: iso(now), signature: "" },
    publishedAt: iso(now + 60),
    publisher: npub(world.publisher),
  };
}

/** A short English-only text story (used as the embedded story and as an unlisted one). */
export function textStory(world: World, title: string, ageSec = 2000): Manifest {
  const t = Math.floor(Date.now() / 1000) - ageSec;
  return {
    schema: "azaadawaaz/story@1",
    id: uuidv7(t * 1000),
    version: 1,
    supersedes: null,
    language: "en",
    title: { en: title },
    summary: { en: `Summary of ${title}` },
    tags: ["update"],
    contributor: { pubkey: world.moderator.npub, displayName: "AzaadAwaaz contributor" },
    blocks: [{ type: "text", markdown: { en: `Text of ${title}.` } }],
    approval: { moderator: world.moderator.npub, approvedAt: iso(t), signature: "" },
    publishedAt: iso(t + 30),
    publisher: world.publisher.npub,
  };
}

// ---- HTTP behaviour of the gateway, Arweave and chain RPC (shared by the unit-test fetch mock and the e2e server) ----

export interface HttpReply {
  status: number;
  body: Uint8Array | string;
  type?: string;
}

/** Overrides for tests: serve wrong bytes for a CID (a lying gateway). */
export interface Tamper {
  cids: Map<string, Uint8Array>;
}

export function gatewayReply(
  world: World,
  path: string,
  query: URLSearchParams,
  accept: string,
  tamper?: Tamper,
): HttpReply {
  const m = path.match(/^\/ipfs\/(.+)$/);
  if (!m) return { status: 404, body: "not found" };
  const target = decodeURIComponent(m[1]!).replace(/\/+$/, "");
  const raw = query.get("format") === "raw" || accept.includes("application/vnd.ipld.raw");
  const bad = tamper?.cids.get(target);
  if (bad) return { status: 200, body: bad, type: raw ? "application/vnd.ipld.raw" : "application/octet-stream" };
  if (raw) {
    const b = world.blocks.get(target);
    return b ? { status: 200, body: b, type: "application/vnd.ipld.raw" } : { status: 404, body: "no block" };
  }
  const f = world.files.get(target);
  return f ? { status: 200, body: f, type: "application/octet-stream" } : { status: 404, body: "no file" };
}

export function arweaveReply(world: World, path: string): HttpReply {
  const b = world.arweave.get(path.replace(/^\//, ""));
  return b ? { status: 200, body: b, type: "application/octet-stream" } : { status: 404, body: "not found" };
}

const pad = (h: string) => h.padStart(64, "0");

function encodePublished(version: number, sha: string, cid: string, timestamp: number): string {
  const cidHex = Array.from(enc.encode(cid), (b) => b.toString(16).padStart(2, "0")).join("");
  const padded = cidHex.padEnd(Math.ceil(cidHex.length / 64) * 64, "0");
  return (
    "0x" +
    pad(version.toString(16)) +
    sha +
    pad((4 * 32).toString(16)) +
    pad(timestamp.toString(16)) +
    pad((cidHex.length / 2).toString(16)) +
    padded
  );
}

export function rpcReply(world: World, body: string): HttpReply {
  const req = JSON.parse(body) as { id: number; method: string; params: any[] };
  const ok = (result: unknown) => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }),
    type: "application/json",
  });
  const find = (topic: string) => [...world.receipts.entries()].filter(([k]) => storyTopic(k.split(":")[0]!) === topic);
  switch (req.method) {
    case "eth_call": {
      const data: string = req.params[0].data;
      if (!data.startsWith(RECEIPT_SELECTOR) || req.params[0].to.toLowerCase() !== world.registry) return ok("0x");
      const idTopic = "0x" + data.slice(10, 74);
      const version = parseInt(data.slice(74, 138), 16);
      const hit = find(idTopic).find(([k]) => Number(k.split(":")[1]) === version)?.[1];
      return ok(hit ? "0x" + hit.sha + pad(hit.timestamp.toString(16)) : "0x" + "0".repeat(128));
    }
    case "eth_getLogs": {
      const f = req.params[0];
      if (f.topics?.[0] !== PUBLISHED_TOPIC) return ok([]);
      return ok(
        find(f.topics[1]).map(([k, r]) => ({
          address: world.registry,
          topics: [PUBLISHED_TOPIC, f.topics[1]],
          data: encodePublished(Number(k.split(":")[1]), r.sha, r.cid, r.timestamp),
          transactionHash: r.tx,
          blockNumber: "0x" + r.block.toString(16),
        })),
      );
    }
    case "eth_getBlockByNumber": {
      const n = parseInt(req.params[0], 16);
      const r = [...world.receipts.values()].find((x) => x.block === n);
      return ok({ number: req.params[0], timestamp: "0x" + (r?.timestamp ?? 0).toString(16) });
    }
    case "eth_blockNumber":
      return ok("0x" + (100 + world.receipts.size).toString(16));
    default:
      return {
        status: 200,
        body: JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } }),
      };
  }
}

/** The app configuration pointing at this world. */
export function worldConfig(world: World) {
  return {
    ownerPubkey: world.owner.pubkey,
    listEvents: world.listEvents,
    apiUrl: world.urls.api ?? "",
    bootstrapRelays: [world.urls.relay],
    chains: [
      {
        key: "base-local",
        chainId: world.chainId,
        rpc: world.urls.rpc,
        registry: world.registry,
        name: "Base (local)",
      },
    ],
    listSnapshots: [],
    powDifficulty: 8,
  };
}
