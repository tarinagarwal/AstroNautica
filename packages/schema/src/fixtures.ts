import { STORY_SCHEMA, type Manifest } from "./types.js";

/** Deterministic test values. Exported for other packages' tests; not part of the public API. */
export const H = (c: string) => c.repeat(64).slice(0, 64);
export const CID = (c: string) => "bafybei" + c.repeat(52).slice(0, 52);
export const NPUB_A = "npub1" + "q".repeat(58);
export const NPUB_B = "npub1" + "p".repeat(58);

export function sampleManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schema: STORY_SCHEMA,
    id: "01928f3e-7c1a-7b2c-8d3e-4f5a6b7c8d9e",
    version: 1,
    supersedes: null,
    language: "both",
    title: { en: "Floods in the valley", hi: "घाटी में बाढ़" },
    summary: { en: "What we saw.", hi: "हमने क्या देखा।" },
    cover: { sha256: H("a"), cid: CID("a"), variants: { "480": CID("b") } },
    tags: ["floods", "बाढ़"],
    contributor: { pubkey: NPUB_A, displayName: "AzaadAwaaz contributor" },
    blocks: [
      { type: "text", markdown: { en: "## Morning\nWater rose.", hi: "## सुबह\nपानी बढ़ा।" } },
      {
        type: "image",
        items: [
          {
            sha256: H("a"),
            cid: CID("a"),
            width: 1600,
            height: 900,
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
            caption: { en: "The bridge", hi: "पुल" },
          },
          { sha256: H("c"), cid: CID("c"), width: 800, height: 600, blurhash: "L00000fQfQfQfQfQfQfQfQfQfQfQ" },
        ],
      },
      {
        type: "video",
        source: { sha256: H("d") },
        title: { en: "Interview" },
        hls: CID("e") + "/master.m3u8",
        mp4: { cid: CID("f"), sha256: H("f") },
        poster: { cid: CID("g"), sha256: H("9") },
        durationSec: 312,
      },
      { type: "embed-story", storyId: "01928f3e-0000-7000-8000-000000000001" },
    ],
    approval: { moderator: NPUB_B, approvedAt: "2026-11-01T10:00:00Z", signature: "ab".repeat(64) },
    publishedAt: "2026-11-01T10:01:12Z",
    publisher: NPUB_B,
    ...overrides,
  };
}
