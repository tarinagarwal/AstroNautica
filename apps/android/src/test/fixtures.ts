/**
 * A complete published story built with packages/core and packages/schema exactly as the publisher does: owner and
 * moderator lists, a manifest approved by a moderator, the publisher's story event and storage receipt, plus
 * in-memory relays and gateways that serve them (optionally tampered).
 */
import {
  createListEvent,
  createStorageReceiptEvent,
  createStoryEvent,
  generateKeyPair,
  signApproval,
  type Event,
  type Filter,
  type PublishResult,
} from "@azaadawaaz/core";
import { canonicalize, manifestSha256, sha256Hex, STORY_SCHEMA, uuidv7, type Manifest } from "@azaadawaaz/schema";
import type { PoolLike } from "../data/appData";
import { rawCidOf } from "../data/ipfs";
import { utf8 } from "../util/bytes";

export const NOW = Math.floor(Date.now() / 1000);

export const owner = generateKeyPair();
export const modA = generateKeyPair();
export const modB = generateKeyPair();
export const publisher = generateKeyPair();
export const contributor = generateKeyPair();
export const PUBLISHER_EVM = "0x" + "ab".repeat(20);
export const OWNER_X = "22".repeat(32);
export const MOD_A_X = "33".repeat(32);

export const GATEWAY = "https://gw.example";
export const PUBLIC_GATEWAY = "https://public.example";
export const ARWEAVE = "https://ar.example";

export function ownerLists(at = NOW - 1000, extra: { publisherEvm?: string } = {}): Event[] {
  return [
    createListEvent("moderators", [{ pubkey: modA.pubkey, x25519: MOD_A_X, from: at - 10_000 }], owner.secretKey, at),
    createListEvent(
      "service-keys",
      [
        { role: "owner", pubkey: owner.pubkey, x25519: OWNER_X, from: at - 10_000 },
        { role: "publisher", pubkey: publisher.pubkey, x25519: "44".repeat(32), evm: extra.publisherEvm ?? PUBLISHER_EVM, from: at - 10_000 },
      ],
      owner.secretKey,
      at,
    ),
    createListEvent("relays", [{ url: "wss://relay.example", operator: "own" }], owner.secretKey, at),
    createListEvent(
      "gateways",
      [
        { url: GATEWAY, network: "ipfs", operator: "own" },
        { url: PUBLIC_GATEWAY, network: "ipfs", operator: "public" },
        { url: ARWEAVE, network: "arweave", operator: "public" },
      ],
      owner.secretKey,
      at,
    ),
  ];
}

export interface PublishedStory {
  manifest: Manifest;
  bytes: Uint8Array;
  sha: string;
  cid: string;
  event: Event;
  receipt: Event;
  files: Map<string, Uint8Array>; // cid → bytes
  media: { image: Uint8Array; mp4: Uint8Array; poster: Uint8Array };
  arweaveTx: string;
}

const rand = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 17 + (i >> 3)) & 255);

export function publishStory(opts: { title?: string; storyId?: string; approver?: typeof modA; publishedAt?: number } = {}): PublishedStory {
  const image = rand(3000, 1);
  const mp4 = rand(5000, 2);
  const poster = rand(1200, 3);
  const imageCid = rawCidOf(image);
  const mp4Cid = rawCidOf(mp4);
  const posterCid = rawCidOf(poster);
  const at = opts.publishedAt ?? NOW - 600;
  const base: Manifest = {
    schema: STORY_SCHEMA,
    id: opts.storyId ?? uuidv7((at - 100) * 1000),
    version: 1,
    supersedes: null,
    language: "both",
    title: { en: opts.title ?? "Floods in the valley", hi: "घाटी में बाढ़" },
    summary: { en: "What we saw.", hi: "हमने क्या देखा।" },
    cover: { sha256: sha256Hex(image), cid: imageCid },
    tags: ["floods"],
    contributor: { pubkey: contributor.npub, displayName: "Pen name" },
    blocks: [
      { type: "text", markdown: { en: "## Morning\nWater rose.", hi: "## सुबह\nपानी बढ़ा।" } },
      { type: "image", items: [{ sha256: sha256Hex(image), cid: imageCid, width: 1600, height: 900, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }] },
      {
        type: "video",
        source: { sha256: "d".repeat(64) },
        hls: "bafybei" + "e".repeat(52) + "/master.m3u8",
        mp4: { cid: mp4Cid, sha256: sha256Hex(mp4) },
        poster: { cid: posterCid, sha256: sha256Hex(poster) },
        durationSec: 31,
      },
    ],
    approval: { moderator: modA.npub, approvedAt: "2000-01-01T00:00:00Z", signature: "00".repeat(64) },
    publishedAt: new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    publisher: publisher.npub,
  };
  const approvedAt = new Date((at - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest: Manifest = { ...base, approval: signApproval(base, (opts.approver ?? modA).secretKey, approvedAt) };
  const bytes = utf8(canonicalize(manifest));
  const sha = manifestSha256(manifest);
  const cid = rawCidOf(bytes);
  const event = createStoryEvent({ manifest, manifestCid: cid, secretKey: publisher.secretKey, createdAt: at });
  const arweaveTx = "A".repeat(43);
  const receipt = createStorageReceiptEvent(
    { storyId: manifest.id, version: 1, manifestSha256: sha, arweave: { [sha]: arweaveTx } },
    publisher.secretKey,
    at + 30,
  );
  const files = new Map<string, Uint8Array>([
    [cid, bytes],
    [imageCid, image],
    [mp4Cid, mp4],
    [posterCid, poster],
  ]);
  return { manifest, bytes, sha, cid, event, receipt, files, media: { image, mp4, poster }, arweaveTx };
}

/** Gateway handler: `/ipfs/<cid>` (whole file or `?format=raw` block) and Arweave `/<tx>`. */
export function gatewayHandler(
  files: Map<string, Uint8Array>,
  opts: { tamper?: Set<string>; arweave?: Map<string, Uint8Array>; down?: Set<string> } = {},
) {
  return (req: { url: string }) => {
    const u = new URL(req.url);
    const base = u.origin;
    if (opts.down?.has(base)) throw new Error("connection refused");
    const m = u.pathname.match(/^\/ipfs\/([a-z2-7]+)$/);
    if (m) {
      const b = files.get(m[1]!);
      if (!b) return { status: 404 };
      if (opts.tamper?.has(base)) return { body: Uint8Array.from(b, (x, i) => (i === 0 ? x ^ 1 : x)) };
      return { body: b };
    }
    const ar = u.pathname.slice(1);
    const a = opts.arweave?.get(ar);
    return a ? { body: a } : { status: 404 };
  };
}

/** A relay set in memory: stores events, answers filters (kinds, authors, ids, #tags, since, limit). */
export class MemoryPool implements PoolLike {
  readonly events = new Map<string, Event>();
  reachable = true;

  constructor(initial: Event[] = []) {
    for (const e of initial) this.events.set(e.id, e);
  }

  static matches(e: Event, f: Filter): boolean {
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    if (f.authors && !f.authors.includes(e.pubkey)) return false;
    if (f.ids && !f.ids.includes(e.id)) return false;
    if (f.since && e.created_at < f.since) return false;
    for (const [k, v] of Object.entries(f)) {
      if (!k.startsWith("#") || !Array.isArray(v)) continue;
      const name = k.slice(1);
      if (!e.tags.some((t) => t[0] === name && (v as string[]).includes(t[1]!))) return false;
    }
    return true;
  }

  async query(_relays: string[], filter: Filter): Promise<Event[]> {
    if (!this.reachable) return [];
    const out = [...this.events.values()].filter((e) => MemoryPool.matches(e, filter)).sort((a, b) => b.created_at - a.created_at);
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async publish(relays: string[], event: Event): Promise<PublishResult[]> {
    if (!this.reachable) return relays.map((relay) => ({ relay, ok: false, message: "unreachable" }));
    this.events.set(event.id, event);
    return relays.map((relay) => ({ relay, ok: true }));
  }
}
