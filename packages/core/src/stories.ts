import {
  hexEquals,
  isSha256Hex,
  isUuidv7,
  manifestSha256,
  sha256Hex,
  validateManifest,
  type Manifest,
} from "@azaadawaaz/schema";
import { finalizeEvent, type Event } from "nostr-tools/pure";
import { verifyApprovalSignature } from "./approval.js";
import { toPubkeyHex, verifyEventStrict } from "./keys.js";
import { KIND_APP_DATA, KIND_STORY, STORAGE_D_PREFIX, TAG_MANIFEST, TAG_VERSION, storageD } from "./kinds.js";
import { wasModeratorAt, wasPublisherAt, type EffectiveLists } from "./lists.js";

export interface StoryRef {
  storyId: string;
  version: number;
  manifestCid: string;
  manifestSha256: string;
  /** Publisher pubkey (hex). */
  publisher: string;
  createdAt: number;
  publishedAt: number;
  title: string;
  summary: string;
  tags: string[];
  language: string;
  coverCid?: string;
  eventId: string;
  /** NIP-33 address `30023:<pubkey>:<story id>`, used by comments and reactions. */
  address: string;
  event: Event;
}

/** Build the publisher-signed NIP-23 event announcing a story version (spec §6 step 7). */
export function createStoryEvent(args: {
  manifest: Manifest;
  manifestCid: string;
  secretKey: Uint8Array;
  createdAt?: number;
}): Event {
  const m = args.manifest;
  const sha = manifestSha256(m);
  const pick = (t: { en?: string; hi?: string }) => t.en ?? t.hi ?? "";
  const summary = m.language === "both" ? `${m.summary.en}\n\n${m.summary.hi}` : pick(m.summary);
  const tags: string[][] = [
    ["d", m.id],
    ["title", m.language === "hi" ? m.title.hi! : m.title.en!],
    ["summary", pick(m.summary)],
    ["published_at", String(Math.floor(Date.parse(m.publishedAt) / 1000))],
    [TAG_MANIFEST, args.manifestCid, sha],
    [TAG_VERSION, String(m.version)],
    ["l", m.language],
    ...m.tags.map((t) => ["t", t]),
  ];
  if (m.title.hi && m.language === "both") tags.push(["title-hi", m.title.hi]);
  if (m.cover) tags.push(["image", m.cover.cid]);
  return finalizeEvent(
    { kind: KIND_STORY, created_at: args.createdAt ?? Math.floor(Date.now() / 1000), tags, content: summary },
    args.secretKey,
  );
}

const tag = (e: Event, name: string) => e.tags.find((t) => t[0] === name);

/** Parse a story event. Checks its signature and shape, not who signed it (see `selectStories`). */
export function parseStoryEvent(e: Event): StoryRef | null {
  if (!e || e.kind !== KIND_STORY) return null;
  const d = tag(e, "d")?.[1];
  const man = tag(e, TAG_MANIFEST);
  const version = Number(tag(e, TAG_VERSION)?.[1]);
  if (!d || !isUuidv7(d) || !man || !man[1] || !isSha256Hex(man[2]) || !Number.isInteger(version) || version < 1)
    return null;
  if (!verifyEventStrict(e)) return null;
  return {
    storyId: d,
    version,
    manifestCid: man[1],
    manifestSha256: man[2]!,
    publisher: e.pubkey,
    createdAt: e.created_at,
    publishedAt: Number(tag(e, "published_at")?.[1] ?? e.created_at),
    title: tag(e, "title")?.[1] ?? "",
    summary: tag(e, "summary")?.[1] ?? "",
    tags: e.tags.filter((t) => t[0] === "t" && t[1]).map((t) => t[1]!),
    language: tag(e, "l")?.[1] ?? "en",
    coverCid: tag(e, "image")?.[1],
    eventId: e.id,
    address: `${KIND_STORY}:${e.pubkey}:${d}`,
    event: e,
  };
}

/**
 * From story events gathered from any number of relays, keep the latest version of each story signed by a valid
 * publisher key, drop unlisted stories, and sort newest first (spec §8).
 */
export function selectStories(
  events: Event[],
  lists: Pick<EffectiveLists, "serviceKeys" | "unlisted"> & { vouched?: EffectiveLists["vouched"] },
  opts: { includeUnlisted?: boolean } = {},
): StoryRef[] {
  const best = new Map<string, StoryRef>();
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e?.id)) continue;
    seen.add(e?.id);
    const r = parseStoryEvent(e);
    if (!r) continue;
    if (!wasPublisherAt(lists, r.publisher, r.createdAt, r.manifestSha256)) continue;
    if (!opts.includeUnlisted && lists.unlisted.has(r.storyId)) continue;
    const cur = best.get(r.storyId);
    if (!cur || r.version > cur.version || (r.version === cur.version && r.createdAt > cur.createdAt)) {
      best.set(r.storyId, r);
    }
  }
  return [...best.values()].sort((a, b) => b.publishedAt - a.publishedAt || (a.storyId < b.storyId ? 1 : -1));
}

export interface ManifestCheck {
  ok: boolean;
  manifest?: Manifest;
  checks: {
    hash: boolean;
    schema: boolean;
    matchesEvent: boolean;
    approvalSignature: boolean;
    moderatorAuthorised: boolean;
    publisherMatches: boolean;
  };
  errors: string[];
}

/** Verify downloaded manifest bytes against the story event that points to them. */
export function verifyManifest(
  bytes: Uint8Array,
  ref: StoryRef,
  lists: Pick<EffectiveLists, "moderators" | "owner">,
): ManifestCheck {
  const checks = {
    hash: false,
    schema: false,
    matchesEvent: false,
    approvalSignature: false,
    moderatorAuthorised: false,
    publisherMatches: false,
  };
  const errors: string[] = [];
  const done = (manifest?: Manifest): ManifestCheck => ({
    ok: Object.values(checks).every(Boolean),
    manifest,
    checks,
    errors,
  });

  checks.hash = hexEquals(sha256Hex(bytes), ref.manifestSha256);
  if (!checks.hash) errors.push("manifest bytes do not match the hash in the story event");

  let m: Manifest;
  try {
    m = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    errors.push("manifest is not valid JSON");
    return done();
  }
  const v = validateManifest(m);
  checks.schema = v.ok;
  if (!v.ok) {
    errors.push(...v.errors);
    return done();
  }
  // The stored bytes must be the canonical form, so the hash is reproducible from the parsed manifest.
  if (checks.hash && !hexEquals(manifestSha256(m), ref.manifestSha256)) {
    checks.hash = false;
    errors.push("manifest is not in canonical form");
  }
  checks.matchesEvent = m.id === ref.storyId && m.version === ref.version;
  if (!checks.matchesEvent) errors.push("manifest id or version differs from the story event");
  checks.approvalSignature = verifyApprovalSignature(m, m.approval);
  if (!checks.approvalSignature) errors.push("approval signature is invalid");
  checks.moderatorAuthorised = wasModeratorAt(
    lists,
    m.approval.moderator,
    Math.floor(Date.parse(m.approval.approvedAt) / 1000),
  );
  if (!checks.moderatorAuthorised) errors.push("approving key was not a moderator at approval time");
  try {
    checks.publisherMatches = toPubkeyHex(m.publisher) === ref.publisher;
  } catch {
    checks.publisherMatches = false;
  }
  if (!checks.publisherMatches) errors.push("manifest publisher differs from the event signer");
  return done(m);
}

// ---- Storage receipts (decision D3) ----

export interface StorageReceipt {
  storyId: string;
  version: number;
  manifestSha256: string;
  /** sha256 → Arweave transaction id. */
  arweave: Record<string, string>;
  publisher: string;
  createdAt: number;
}

export function createStorageReceiptEvent(
  r: Omit<StorageReceipt, "publisher" | "createdAt">,
  secretKey: Uint8Array,
  createdAt = Math.floor(Date.now() / 1000),
): Event {
  return finalizeEvent(
    {
      kind: KIND_APP_DATA,
      created_at: createdAt,
      tags: [
        ["d", storageD(r.storyId, r.version)],
        [TAG_MANIFEST, "", r.manifestSha256],
      ],
      content: JSON.stringify({
        schema: "azaadawaaz/storage@1",
        storyId: r.storyId,
        version: r.version,
        manifestSha256: r.manifestSha256,
        arweave: r.arweave,
      }),
    },
    secretKey,
  );
}

const ARWEAVE_TX = /^[A-Za-z0-9_-]{43}$/;

export function parseStorageReceipt(
  e: Event,
  lists: Pick<EffectiveLists, "serviceKeys"> & { vouched?: EffectiveLists["vouched"] },
): StorageReceipt | null {
  if (e?.kind !== KIND_APP_DATA) return null;
  const d = tag(e, "d")?.[1];
  if (!d?.startsWith(STORAGE_D_PREFIX)) return null;
  if (!verifyEventStrict(e)) return null;
  try {
    const c = JSON.parse(e.content);
    if (c.schema !== "azaadawaaz/storage@1" || d !== storageD(c.storyId, c.version)) return null;
    if (!isSha256Hex(c.manifestSha256) || typeof c.arweave !== "object" || c.arweave === null) return null;
    if (!wasPublisherAt(lists, e.pubkey, e.created_at, c.manifestSha256)) return null;
    const arweave: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.arweave))
      if (isSha256Hex(k) && typeof v === "string" && ARWEAVE_TX.test(v)) arweave[k] = v;
    return {
      storyId: c.storyId,
      version: c.version,
      manifestSha256: c.manifestSha256,
      arweave,
      publisher: e.pubkey,
      createdAt: e.created_at,
    };
  } catch {
    return null;
  }
}
