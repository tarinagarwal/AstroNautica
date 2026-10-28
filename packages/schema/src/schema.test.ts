import { describe, expect, it } from "vitest";
import {
  approvalBody,
  approvalBodySha256,
  approvalMessageHash,
  bytes16ToStoryId,
  canonicalize,
  isUuidv7,
  manifestSha256,
  mediaHashes,
  sha256Hex,
  storyIdToBytes16,
  uuidv7,
  validateApprovalBody,
  validateManifest,
} from "./index.js";
import { CID, H, sampleManifest } from "./fixtures.js";

describe("JCS (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "\uFB33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","😀":"Emoji: Grinning Face","\uFB33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("serialises numbers like ECMAScript", () => {
    // eslint-disable-next-line no-loss-of-precision -- RFC 8785 test vector
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 0.000001, 1e21, -0])).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,0.000001,1e+21,0]",
    );
  });

  it("has no whitespace and drops undefined members", () => {
    expect(canonicalize({ b: [1, { d: true, c: null }], a: "x", u: undefined })).toBe(
      '{"a":"x","b":[1,{"c":null,"d":true}]}',
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ n: NaN })).toThrow();
  });

  it("is independent of key insertion order", () => {
    expect(canonicalize({ a: 1, b: { y: 2, x: 1 } })).toBe(canonicalize({ b: { x: 1, y: 2 }, a: 1 }));
  });
});

describe("hashing", () => {
  it("matches the SHA-256 test vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("changes the manifest hash when any byte changes", () => {
    const m = sampleManifest();
    const h = manifestSha256(m);
    expect(manifestSha256(sampleManifest())).toBe(h);
    expect(manifestSha256({ ...m, title: { en: "Floods in the valley!", hi: m.title.hi! } })).not.toBe(h);
  });
});

describe("approval body", () => {
  it("drops approval, publication and derived media fields", () => {
    const body = approvalBody(sampleManifest());
    expect(body).not.toHaveProperty("approval");
    expect(body).not.toHaveProperty("publishedAt");
    expect(body).not.toHaveProperty("publisher");
    expect(body.cover).toEqual({ sha256: H("a") });
    expect(body.blocks[1]).toEqual({
      type: "image",
      items: [{ sha256: H("a"), caption: { en: "The bridge", hi: "पुल" } }, { sha256: H("c") }],
    });
    expect(body.blocks[2]).toEqual({ type: "video", source: { sha256: H("d") }, title: { en: "Interview" } });
  });

  it("is stable across processing: derived fields don't change the approval hash", () => {
    const m = sampleManifest();
    const reprocessed = structuredClone(m);
    const img = reprocessed.blocks[1]!;
    if (img.type === "image") img.items[0]!.cid = CID("z");
    reprocessed.publishedAt = "2026-12-01T00:00:00Z";
    expect(approvalBodySha256(reprocessed)).toBe(approvalBodySha256(m));
    expect(approvalBodySha256(approvalBody(m))).toBe(approvalBodySha256(m));
  });

  it("changes when approved content changes", () => {
    const m = sampleManifest();
    const edited = structuredClone(m);
    const t = edited.blocks[0]!;
    if (t.type === "text") t.markdown.en = "## Morning\nWater fell.";
    expect(approvalBodySha256(edited)).not.toBe(approvalBodySha256(m));
    // Reordering blocks also changes it.
    const reordered = { ...m, blocks: [...m.blocks].reverse() };
    expect(approvalBodySha256(reordered)).not.toBe(approvalBodySha256(m));
  });

  it("does not share references with the input", () => {
    const m = sampleManifest();
    const body = approvalBody(m);
    body.title.en = "changed";
    expect(m.title.en).toBe("Floods in the valley");
  });

  it("binds the approval time into the signed message", () => {
    const b = approvalBodySha256(sampleManifest());
    expect(approvalMessageHash(b, "2026-11-01T10:00:00Z")).not.toBe(approvalMessageHash(b, "2026-11-01T10:00:01Z"));
  });

  it("lists original media hashes", () => {
    expect(mediaHashes(sampleManifest())).toEqual([H("a"), H("a"), H("c"), H("d")]);
  });
});

describe("validation", () => {
  it("accepts the sample manifest and its approval body", () => {
    expect(validateManifest(sampleManifest())).toEqual({ ok: true });
    expect(validateApprovalBody(approvalBody(sampleManifest()))).toEqual({ ok: true });
  });

  it("does not require derived fields in an approval body", () => {
    const body = approvalBody(sampleManifest());
    expect(validateApprovalBody(body)).toEqual({ ok: true });
    expect(validateManifest(body).ok).toBe(false);
  });

  it("enforces the story language on every text field", () => {
    const r = validateManifest(sampleManifest({ language: "en" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('title.hi is not allowed in a "en" story');

    const missing = sampleManifest({ title: { en: "Only English" } });
    const r2 = validateManifest(missing);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors).toContain("title.hi is required");
  });

  it("accepts any combination of blocks, including video only", () => {
    const m = sampleManifest();
    expect(validateManifest({ ...m, blocks: [m.blocks[2]!] })).toEqual({ ok: true });
    expect(validateManifest({ ...m, blocks: [m.blocks[1]!] })).toEqual({ ok: true });
  });

  it("enforces limits", () => {
    const m = sampleManifest();
    expect(validateManifest({ ...m, blocks: [] }).ok).toBe(false);
    expect(validateManifest({ ...m, blocks: Array(101).fill(m.blocks[0]) }).ok).toBe(false);
    expect(validateManifest({ ...m, tags: Array(11).fill("t") }).ok).toBe(false);
    expect(validateManifest({ ...m, summary: { en: "x".repeat(301), hi: "ठीक" } }).ok).toBe(false);
    expect(validateManifest({ ...m, summary: { en: "x".repeat(300), hi: "ठीक" } }).ok).toBe(true);
  });

  it("requires supersedes to match the version", () => {
    expect(validateManifest(sampleManifest({ version: 2 })).ok).toBe(false);
    expect(validateManifest(sampleManifest({ version: 2, supersedes: H("1") })).ok).toBe(true);
    expect(validateManifest(sampleManifest({ supersedes: H("1") })).ok).toBe(false);
  });

  it("rejects fields a moderator never saw, at every level", () => {
    const m = sampleManifest();
    const withExtra = (f: (x: any) => void) => {
      const c: any = structuredClone(m);
      f(c);
      return validateManifest(c).ok;
    };
    expect(withExtra((c) => (c.blocks[0].hidden = "UNAPPROVED"))).toBe(false);
    expect(withExtra((c) => (c.blocks[0].html = "<script>"))).toBe(false);
    expect(withExtra((c) => (c.blocks[1].items[0].extra = 1))).toBe(false);
    expect(withExtra((c) => (c.blocks[3].note = "x"))).toBe(false);
    expect(withExtra((c) => (c.contributor.email = "a@b"))).toBe(false);
    expect(withExtra((c) => (c.extra = true))).toBe(false);
    expect(withExtra((c) => (c.approval.note = "x"))).toBe(false);
    expect(withExtra((c) => (c.blocks[2].mp4.extra = "x"))).toBe(false);
    expect(withExtra((c) => (c.cover.variants["2048"] = c.cover.cid))).toBe(false);
    const body: any = approvalBody(m);
    body.blocks[0].hidden = "x";
    expect(validateApprovalBody(body).ok).toBe(false);
    expect(validateApprovalBody({ ...approvalBody(m), cid: "x" }).ok).toBe(false);
  });

  it("rejects unknown block types and garbage", () => {
    const m = sampleManifest();
    expect(validateManifest({ ...m, blocks: [{ type: "html", html: "<script>" }] as never }).ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest("x").ok).toBe(false);
  });
});

describe("story ids", () => {
  it("generates valid, time-ordered UUIDv7s", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isUuidv7(a)).toBe(true);
    expect(a < b).toBe(true);
  });

  it("round-trips through bytes16", () => {
    const id = uuidv7();
    const b16 = storyIdToBytes16(id);
    expect(b16).toMatch(/^0x[0-9a-f]{32}$/);
    expect(bytes16ToStoryId(b16)).toBe(id);
  });
});
