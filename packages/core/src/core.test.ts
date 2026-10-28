import { describe, expect, it, vi } from "vitest";
import { approvalBody, manifestSha256, canonicalize, sha256Hex, type Manifest } from "@azaadawaaz/schema";
import { sampleManifest } from "@azaadawaaz/schema/fixtures";
import type { Event } from "nostr-tools/pure";
import {
  buildCommentThread,
  buildEffectiveLists,
  commentTemplate,
  committedPow,
  countReactions,
  createAuthHeader,
  createInvite,
  createListEvent,
  createRedemption,
  createStorageReceiptEvent,
  createStoryEvent,
  createTranslator,
  currentPublisher,
  decodeInvite,
  decryptBytes,
  decryptJson,
  detectLanguage,
  editModeratorList,
  encryptBytes,
  encryptJson,
  fetchVerified,
  formatNumber,
  GatewayScoreboard,
  generateEncryptionKeyPair,
  generateKeyPair,
  hexToNpub,
  mineAndSign,
  newContentKey,
  npubToHex,
  parseSecretKey,
  parseStorageReceipt,
  pickText,
  reactionTemplate,
  selectStories,
  signApproval,
  sourcesFor,
  unwrapKey,
  verifyApprovalSignature,
  verifyAuthHeader,
  verifyInvite,
  verifyManifest,
  verifyRedemption,
  verifyEventStrict,
  wasModeratorAt,
  wrapKey,
  wrapKeyFor,
  type GatewayEntry,
  type StoryRef,
} from "./index.js";

const NOW = 1_800_000_000;
const owner = generateKeyPair();
const modA = generateKeyPair();
const modB = generateKeyPair();
const publisher = generateKeyPair();
const contributor = generateKeyPair();
const X = "11".repeat(32);

function ownerLists(extra: Event[] = [], moderators = [modA, modB], until?: Record<string, number>) {
  return [
    createListEvent(
      "moderators",
      moderators.map((m) => ({ pubkey: m.pubkey, x25519: X, from: NOW - 10_000, until: until?.[m.pubkey] })),
      owner.secretKey,
      NOW - 100,
    ),
    createListEvent(
      "service-keys",
      [{ role: "publisher", pubkey: publisher.pubkey, x25519: X, from: NOW - 10_000 }],
      owner.secretKey,
      NOW - 100,
    ),
    ...extra,
  ];
}

/** A manifest approved by `mod` and published by `publisher`. */
function publishedManifest(mod = modA, over: Partial<Manifest> = {}): Manifest {
  const base = sampleManifest({
    contributor: { pubkey: contributor.npub, displayName: "Pen name" },
    publisher: publisher.npub,
    ...over,
  });
  return { ...base, approval: signApproval(base, mod.secretKey, "2027-01-15T08:00:00Z") };
}

describe("keys", () => {
  it("never trusts nostr-tools' cached verification on edited copies", () => {
    const e = createListEvent("relays", [], owner.secretKey, NOW);
    expect(verifyEventStrict(e)).toBe(true);
    expect(verifyEventStrict({ ...e, content: "edited" })).toBe(false);
    expect(verifyEventStrict({ ...e, tags: [["d", "x"]] })).toBe(false);
    expect(verifyEventStrict(JSON.parse(JSON.stringify(e)))).toBe(true);
  });

  it("round-trips npub and nsec", () => {
    const k = generateKeyPair();
    expect(npubToHex(k.npub)).toBe(k.pubkey);
    expect(hexToNpub(k.pubkey)).toBe(k.npub);
    expect(parseSecretKey(k.nsec)).toEqual(k.secretKey);
    expect(() => parseSecretKey("nope")).toThrow();
  });
});

describe("approval signatures", () => {
  it("verifies over the approval body and survives processing", () => {
    const m = publishedManifest();
    expect(verifyApprovalSignature(m, m.approval)).toBe(true);
    // The moderator signed the approval body before processing; it must verify against it too.
    expect(verifyApprovalSignature(approvalBody(m), m.approval)).toBe(true);
  });

  it("fails if any approved content changes", () => {
    const m = publishedManifest();
    const t = structuredClone(m);
    t.title.en = "Different";
    expect(verifyApprovalSignature(t, m.approval)).toBe(false);
    expect(verifyApprovalSignature(m, { ...m.approval, approvedAt: "2027-01-15T08:00:01Z" })).toBe(false);
    expect(verifyApprovalSignature(m, { ...m.approval, moderator: modB.npub })).toBe(false);
    expect(verifyApprovalSignature(m, { ...m.approval, moderator: "garbage" })).toBe(false);
  });
});

describe("signed lists (two tiers)", () => {
  it("trusts only owner-signed owner lists", () => {
    const forged = createListEvent("moderators", [{ pubkey: modB.pubkey, x25519: X, from: 0 }], modA.secretKey, NOW);
    const L = buildEffectiveLists(owner.npub, [forged], { now: NOW });
    expect(L.moderators).toEqual([]);
  });

  it("picks the newest owner list and ignores future-dated ones", () => {
    const old = createListEvent("relays", [{ url: "wss://old.example", operator: "own" }], owner.secretKey, NOW - 50);
    const cur = createListEvent("relays", [{ url: "wss://new.example", operator: "own" }], owner.secretKey, NOW - 10);
    const future = createListEvent(
      "relays",
      [{ url: "wss://evil.example", operator: "own" }],
      owner.secretKey,
      NOW + 9999,
    );
    const L = buildEffectiveLists(owner.pubkey, [cur, future, old], { now: NOW });
    expect(L.relays.map((r) => r.url)).toEqual(["wss://new.example"]);
  });

  it("rejects tampered list events", () => {
    const e = createListEvent("relays", [{ url: "wss://a.example", operator: "own" }], owner.secretKey, NOW - 10);
    const tampered = { ...e, content: e.content.replace("a.example", "evil.example") };
    expect(buildEffectiveLists(owner.pubkey, [tampered], { now: NOW }).relays).toEqual([]);
  });

  it("drops malformed items but keeps valid ones", () => {
    const e = createListEvent(
      "relays",
      [{ url: "wss://ok.example", operator: "own" }, { url: "javascript:alert(1)", operator: "own" } as never],
      owner.secretKey,
      NOW - 10,
    );
    expect(buildEffectiveLists(owner.pubkey, [e], { now: NOW }).relays).toHaveLength(1);
  });

  it("unions moderator lists across current moderators and the owner", () => {
    const events = ownerLists([
      createListEvent("unlisted", [["story-1", NOW - 5]], modA.secretKey, NOW - 5),
      createListEvent("unlisted", [["story-2", NOW - 5]], modB.secretKey, NOW - 5),
      createListEvent("unlisted", [["story-3", NOW - 5]], owner.secretKey, NOW - 5),
      createListEvent("unlisted", [["story-4", NOW - 5]], contributor.secretKey, NOW - 5), // not a moderator
    ]);
    const L = buildEffectiveLists(owner.pubkey, events, { now: NOW });
    expect([...L.unlisted].sort()).toEqual(["story-1", "story-2", "story-3"]);
    expect(L.provenance.get("unlisted|story-1")).toEqual([modA.pubkey]);
  });

  it("stops counting a removed moderator's entries but keeps their past approvals valid", () => {
    const events = ownerLists([createListEvent("hidden", [["c1", NOW - 5]], modB.secretKey, NOW - 5)], [modA, modB], {
      [modB.pubkey]: NOW - 1,
    });
    const L = buildEffectiveLists(owner.pubkey, events, { now: NOW });
    expect(L.hidden.has("c1")).toBe(false);
    expect(L.activeModerators.has(modB.pubkey)).toBe(false);
    expect(wasModeratorAt(L, modB.npub, NOW - 100)).toBe(true);
    expect(wasModeratorAt(L, modB.npub, NOW)).toBe(false);
  });

  it("applies owner overrides", () => {
    const events = ownerLists([
      createListEvent("unlisted", [["story-1", NOW - 5]], modA.secretKey, NOW - 5),
      createListEvent("overrides", [{ list: "unlisted", value: "story-1" }], owner.secretKey, NOW - 1),
    ]);
    expect(buildEffectiveLists(owner.pubkey, events, { now: NOW }).unlisted.size).toBe(0);
  });

  it("caps how much a single moderator can unlist per day", () => {
    const items = Array.from({ length: 30 }, (_, i) => [`s${i}`, NOW - 100 + i] as [string, number]);
    const events = ownerLists([createListEvent("unlisted", items, modA.secretKey, NOW - 1)]);
    const L = buildEffectiveLists(owner.pubkey, events, { now: NOW });
    expect(L.unlisted.size).toBe(20);
    expect(L.unlisted.has("s0")).toBe(true);
    expect(L.unlisted.has("s29")).toBe(false);
    // The owner is not capped.
    const ownerEvents = ownerLists([createListEvent("unlisted", items, owner.secretKey, NOW - 1)]);
    expect(buildEffectiveLists(owner.pubkey, ownerEvents, { now: NOW }).unlisted.size).toBe(30);
  });

  it("computes contributors minus revocations", () => {
    const events = ownerLists([
      createListEvent(
        "contributors",
        [
          ["c1", NOW - 9],
          ["c2", NOW - 9],
        ],
        modA.secretKey,
        NOW - 9,
      ),
      createListEvent("revoked-contributors", [["c2", NOW - 5]], modB.secretKey, NOW - 5),
    ]);
    const L = buildEffectiveLists(owner.pubkey, events, { now: NOW });
    expect([...L.contributors]).toEqual(["c1"]);
  });

  it("edits moderator lists idempotently", () => {
    let items = editModeratorList([], "add", "x", 1);
    items = editModeratorList(items, "add", "x", 2);
    expect(items).toEqual([["x", 2]]);
    expect(editModeratorList(items, "remove", "x")).toEqual([]);
  });

  it("knows the current publisher after a rotation", () => {
    const next = generateKeyPair();
    const events = [
      createListEvent(
        "service-keys",
        [
          { role: "publisher", pubkey: publisher.pubkey, from: NOW - 1000, until: NOW - 10 },
          { role: "publisher", pubkey: next.pubkey, from: NOW - 10 },
        ],
        owner.secretKey,
        NOW - 5,
      ),
    ];
    const L = buildEffectiveLists(owner.pubkey, events, { now: NOW });
    expect(currentPublisher(L, NOW)?.pubkey).toBe(next.pubkey);
  });
});

describe("verified fetching", () => {
  const good = new TextEncoder().encode("the real file");
  const goodHash = sha256Hex(good);
  const gateways: GatewayEntry[] = [
    { url: "https://public.example", network: "ipfs", operator: "public" },
    { url: "https://own.example/", network: "ipfs", operator: "own" },
    { url: "https://ar.example", network: "arweave", operator: "public" },
  ];

  it("orders own gateways first and builds URLs", () => {
    const s = sourcesFor({ cid: "bafyx", arweave: "tx" }, gateways);
    expect(s.map((x) => x.url)).toEqual([
      "https://own.example/ipfs/bafyx",
      "https://public.example/ipfs/bafyx",
      "https://ar.example/tx",
    ]);
  });

  it("skips and flags a source serving tampered bytes", async () => {
    const board = new GatewayScoreboard();
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("evil") ? new Response("tampered") : new Response(good),
    );
    const bytes = await fetchVerified({
      sources: [
        { base: "https://evil", url: "https://evil/x" },
        { base: "https://ok", url: "https://ok/x" },
      ],
      sha256: goodHash,
      fetch: fetchMock,
      raceWidth: 1,
      scoreboard: board,
    });
    expect(new TextDecoder().decode(bytes)).toBe("the real file");
    expect(board.isFlagged("https://evil")).toBe(true);
    expect(board.order(["https://evil", "https://ok"], (x) => x)).toEqual(["https://ok", "https://evil"]);
  });

  it("falls back past failing and slow sources", async () => {
    const fetchMock = async (url: string, init?: { signal?: AbortSignal }) => {
      if (url.includes("down")) throw new TypeError("network");
      if (url.includes("404")) return new Response("no", { status: 404 });
      if (url.includes("slow"))
        return new Promise<Response>((_, rej) =>
          init?.signal?.addEventListener("abort", () => rej(new Error("abort"))),
        );
      return new Response(good);
    };
    const reports: string[] = [];
    const bytes = await fetchVerified({
      sources: ["down", "404", "slow", "ok"].map((n) => ({ base: n, url: `https://${n}/f` })),
      sha256: goodHash,
      fetch: fetchMock,
      raceWidth: 3,
      timeoutMs: 100,
      onReport: (r) => reports.push(`${r.url}:${r.reason ?? "ok"}`),
    });
    expect(bytes).toEqual(good);
    expect(reports).toContain("https://down/f:network");
    expect(reports).toContain("https://404/f:http");
    expect(reports).toContain("https://slow/f:timeout");
  });

  it("throws when nobody has the right bytes", async () => {
    await expect(
      fetchVerified({
        sources: [{ base: "a", url: "https://a/f" }],
        sha256: goodHash,
        fetch: async () => new Response("wrong"),
      }),
    ).rejects.toThrow(/no source/);
  });
});

describe("stories", () => {
  function setup() {
    const m = publishedManifest();
    const bytes = new TextEncoder().encode(canonicalize(m));
    const ev = createStoryEvent({
      manifest: m,
      manifestCid: "bafymanifest",
      secretKey: publisher.secretKey,
      createdAt: NOW - 50,
    });
    const L = buildEffectiveLists(owner.pubkey, ownerLists(), { now: NOW });
    return { m, bytes, ev, L };
  }

  it("selects the latest version from valid publishers only", () => {
    const { m, ev, L } = setup();
    const v2m = publishedManifest(modA, { version: 2, supersedes: manifestSha256(m) });
    const v2 = createStoryEvent({
      manifest: v2m,
      manifestCid: "bafyv2",
      secretKey: publisher.secretKey,
      createdAt: NOW - 40,
    });
    const impostor = createStoryEvent({
      manifest: m,
      manifestCid: "bafyfake",
      secretKey: modA.secretKey,
      createdAt: NOW - 30,
    });
    const stories = selectStories([ev, v2, impostor, ev], L);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.version).toBe(2);
    expect(stories[0]!.manifestCid).toBe("bafyv2");
  });

  it("hides unlisted stories", () => {
    const { m, ev } = setup();
    const L = buildEffectiveLists(
      owner.pubkey,
      ownerLists([createListEvent("unlisted", [[m.id, NOW - 5]], modB.secretKey, NOW - 5)]),
      { now: NOW },
    );
    expect(selectStories([ev], L)).toHaveLength(0);
    expect(selectStories([ev], L, { includeUnlisted: true })).toHaveLength(1);
  });

  it("verifies a genuine manifest end to end", () => {
    const { bytes, ev, L } = setup();
    const ref = selectStories([ev], L)[0]!;
    const r = verifyManifest(bytes, ref, L);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails verification for a tampered copy (any byte)", () => {
    const { bytes, ev, L } = setup();
    const ref = selectStories([ev], L)[0]!;
    const tampered = bytes.slice();
    const i = new TextDecoder().decode(bytes).indexOf("Water rose");
    tampered[i] = "w".charCodeAt(0);
    const r = verifyManifest(tampered, ref, L);
    expect(r.ok).toBe(false);
    expect(r.checks.hash).toBe(false);
    expect(r.checks.approvalSignature).toBe(false);
  });

  it("fails verification when approved by a non-moderator", () => {
    const m = publishedManifest(contributor);
    const bytes = new TextEncoder().encode(canonicalize(m));
    const ev = createStoryEvent({
      manifest: m,
      manifestCid: "bafy",
      secretKey: publisher.secretKey,
      createdAt: NOW - 5,
    });
    const L = buildEffectiveLists(owner.pubkey, ownerLists(), { now: NOW });
    const r = verifyManifest(bytes, selectStories([ev], L)[0]!, L);
    expect(r.checks.approvalSignature).toBe(true);
    expect(r.checks.moderatorAuthorised).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("rejects non-canonical manifest bytes even if hashed", () => {
    const { m, L } = setup();
    const pretty = new TextEncoder().encode(JSON.stringify(m, null, 2));
    const ref: StoryRef = { ...selectStories([setup().ev], L)[0]!, manifestSha256: sha256Hex(pretty) };
    const r = verifyManifest(pretty, ref, L);
    expect(r.checks.hash).toBe(false);
  });

  it("round-trips storage receipts and rejects them from non-publishers", () => {
    const { m, L } = setup();
    const r = {
      storyId: m.id,
      version: 1,
      manifestSha256: manifestSha256(m),
      arweave: { [manifestSha256(m)]: "A".repeat(43), bad: "x" },
    };
    const ev = createStorageReceiptEvent(r, publisher.secretKey, NOW - 5);
    const parsed = parseStorageReceipt(ev, L);
    expect(parsed?.arweave).toEqual({ [manifestSha256(m)]: "A".repeat(43) });
    expect(parseStorageReceipt(createStorageReceiptEvent(r, modA.secretKey, NOW - 5), L)).toBeNull();
  });
});

describe("comments and reactions", () => {
  const story = { address: `30023:${publisher.pubkey}:id`, eventId: "e".repeat(64), publisher: publisher.pubkey };
  const reader = generateKeyPair();
  const noLists = { hidden: new Set<string>(), muted: new Set<string>() };

  it("mines proof-of-work that relays and clients accept", async () => {
    const e = await mineAndSign(commentTemplate({ story, content: "hello" }), reader.secretKey, 12);
    expect(committedPow(e)).toBeGreaterThanOrEqual(12);
  });

  it("threads comments and honours hide, mute and PoW", async () => {
    const c1 = await mineAndSign(commentTemplate({ story, content: "first", createdAt: 1 }), reader.secretKey, 8);
    const r1 = await mineAndSign(
      commentTemplate({ story, content: "reply", parent: c1, createdAt: 2 }),
      modA.secretKey,
      8,
    );
    const c2 = await mineAndSign(commentTemplate({ story, content: "second", createdAt: 3 }), modB.secretKey, 8);
    const weak = await mineAndSign(commentTemplate({ story, content: "spam", createdAt: 4 }), contributor.secretKey, 0);
    const other = await mineAndSign(
      commentTemplate({ story: { ...story, address: "30023:x:other" }, content: "elsewhere" }),
      reader.secretKey,
      8,
    );

    const t = buildCommentThread([c2, r1, c1, weak, other], story.address, noLists, 8);
    expect(t.map((n) => n.event.content)).toEqual(["first", "second"]);
    expect(t[0]!.replies.map((n) => n.event.content)).toEqual(["reply"]);

    const hidden = buildCommentThread([c1, r1, c2], story.address, { hidden: new Set([c1.id]), muted: new Set() }, 8);
    expect(hidden.map((n) => n.event.content)).toEqual(["second"]);
    const muted = buildCommentThread(
      [c1, r1, c2],
      story.address,
      { hidden: new Set(), muted: new Set([modB.pubkey]) },
      8,
    );
    expect(muted.map((n) => n.event.content)).toEqual(["first"]);
  });

  it("rejects over-long comments", () => {
    expect(() => commentTemplate({ story, content: "x".repeat(2001) })).toThrow();
    expect(() => commentTemplate({ story, content: "   " })).toThrow();
  });

  it("counts one reaction per key per emoji", async () => {
    const a = await mineAndSign(reactionTemplate({ story, reaction: "❤️" }), reader.secretKey, 4);
    const b = await mineAndSign(reactionTemplate({ story, reaction: "❤️", createdAt: 5 }), reader.secretKey, 4);
    const c = await mineAndSign(reactionTemplate({ story, reaction: "⭐" }), modA.secretKey, 4);
    const counts = countReactions([a, b, c], story.address, noLists, 4);
    expect(counts["❤️"]).toBe(1);
    expect(counts["⭐"]).toBe(1);
    expect(counts["👍"]).toBe(0);
  });
});

describe("staging encryption", () => {
  it("wraps content keys per recipient and only they can unwrap", async () => {
    const mod = await generateEncryptionKeyPair();
    const pub = await generateEncryptionKeyPair();
    const stranger = await generateEncryptionKeyPair();
    const key = await newContentKey();
    const wrapped = await wrapKeyFor(key, [mod.publicKey]);
    const k = await unwrapKey(wrapped[mod.publicKey]!, mod);
    expect(k).toEqual(key);
    await expect(unwrapKey(wrapped[mod.publicKey]!, stranger)).rejects.toThrow();
    // Approval: the moderator re-wraps for the publisher.
    const forPublisher = await wrapKey(k, pub.publicKey);
    expect(await unwrapKey(forPublisher, pub)).toEqual(key);
  });

  it("encrypts in chunks and detects tampering, reordering and truncation", async () => {
    const key = await newContentKey();
    const data = new Uint8Array(2_500_000).map((_, i) => i % 251);
    const blob = await encryptBytes(data, key);
    expect(blob.chunks).toHaveLength(3);
    expect(sha256Hex(await decryptBytes(blob, key))).toBe(sha256Hex(data));

    const tampered = { header: blob.header, chunks: blob.chunks.map((c) => c.slice()) };
    tampered.chunks[1]![10]! ^= 1;
    await expect(decryptBytes(tampered, key)).rejects.toThrow();
    await expect(
      decryptBytes({ header: blob.header, chunks: [blob.chunks[1]!, blob.chunks[0]!, blob.chunks[2]!] }, key),
    ).rejects.toThrow();
    await expect(decryptBytes({ header: blob.header, chunks: blob.chunks.slice(0, 2) }, key)).rejects.toThrow(
      /truncated/,
    );
  });

  it("encrypts JSON", async () => {
    const key = await newContentKey();
    const sealed = await encryptJson({ title: "घाटी" }, key);
    expect(await decryptJson(sealed, key)).toEqual({ title: "घाटी" });
    await expect(decryptJson(sealed, await newContentKey())).rejects.toThrow();
  });
});

describe("HTTP auth and invites", () => {
  it("verifies NIP-98 headers bound to url, method and body", () => {
    const body = JSON.stringify({ a: 1 });
    const h = createAuthHeader("http://api/x", "post", contributor.secretKey, body, NOW);
    const ok = verifyAuthHeader(h, "http://api/x", "POST", body, NOW);
    expect(ok).toMatchObject({ ok: true, pubkey: contributor.pubkey });
    expect(verifyAuthHeader(h, "http://api/y", "POST", body, NOW).ok).toBe(false);
    expect(verifyAuthHeader(h, "http://api/x", "GET", body, NOW).ok).toBe(false);
    expect(verifyAuthHeader(h, "http://api/x", "POST", '{"a":2}', NOW).ok).toBe(false);
    expect(verifyAuthHeader(h, "http://api/x", "POST", body, NOW + 120).ok).toBe(false);
    expect(verifyAuthHeader(undefined, "http://api/x", "POST").ok).toBe(false);
  });

  it("issues owner-signed invites and verifies redemptions", () => {
    const inv = createInvite(owner.secretKey, { expiresAt: NOW + 100, note: "for R." }, NOW);
    const decoded = decodeInvite(inv.link);
    expect(verifyInvite(decoded, owner.npub, NOW)).toMatchObject({ ok: true });
    expect(verifyInvite(decoded, owner.npub, NOW + 101)).toMatchObject({ ok: false, error: "invite expired" });
    expect(verifyInvite(createInvite(modA.secretKey).event, owner.npub).ok).toBe(false);

    const red = createRedemption(decoded, contributor.secretKey, NOW);
    expect(verifyRedemption(red, owner.pubkey, NOW)).toMatchObject({ ok: true, contributor: contributor.pubkey });
    const swapped = { ...red, content: JSON.stringify(createInvite(owner.secretKey).event) };
    expect(verifyRedemption(swapped, owner.pubkey, NOW).ok).toBe(false);
  });
});

describe("i18n", () => {
  it("detects language and translates with fallback", () => {
    expect(detectLanguage(["hi-IN", "en"])).toBe("hi");
    expect(detectLanguage(["fr"])).toBe("en");
    const t = createTranslator("hi", { en: { "only.en": "English only" } });
    expect(t("nav.home")).toBe("मुखपृष्ठ");
    expect(t("only.en")).toBe("English only");
    expect(t("missing.key")).toBe("missing.key");
    expect(createTranslator("en")("story.by", { name: "R" })).toBe("By R");
    expect(formatNumber(1234567, "en")).toBe("12,34,567");
    expect(pickText({ hi: "केवल" }, "en")).toBe("केवल");
  });

  it("has every English key in Hindi", async () => {
    const en = (await import("./i18n/en.json")).default;
    const hi = (await import("./i18n/hi.json")).default;
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
  });
});
