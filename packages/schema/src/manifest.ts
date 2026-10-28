import { canonicalSha256 } from "./hash.js";
import type { ApprovalBlock, ApprovalBody, Block, Manifest } from "./types.js";

/**
 * Project a manifest (or an approval body) onto the approval body: the manifest without `approval`, `publishedAt`,
 * `publisher` and every field derived after approval. This is the single implementation every party uses (spec §4.2).
 */
export function approvalBody(m: Manifest | ApprovalBody): ApprovalBody {
  const body: ApprovalBody = {
    schema: m.schema,
    id: m.id,
    version: m.version,
    supersedes: m.supersedes,
    language: m.language,
    title: m.title,
    summary: m.summary,
    tags: m.tags,
    contributor: m.contributor,
    blocks: m.blocks.map(approvalBlock),
  };
  if (m.cover) body.cover = { sha256: m.cover.sha256 };
  if (m.location) body.location = m.location;
  return structuredClone(body);
}

function approvalBlock(b: Block | ApprovalBlock): ApprovalBlock {
  switch (b.type) {
    case "text":
      return { type: "text", markdown: b.markdown };
    case "image":
      return {
        type: "image",
        items: b.items.map((i) => (i.caption ? { sha256: i.sha256, caption: i.caption } : { sha256: i.sha256 })),
      };
    case "video": {
      const v: ApprovalBlock = { type: "video", source: { sha256: b.source.sha256 } };
      if (b.title) v.title = b.title;
      if (b.description) v.description = b.description;
      return v;
    }
    case "embed-story":
      return b.version === undefined
        ? { type: "embed-story", storyId: b.storyId }
        : { type: "embed-story", storyId: b.storyId, version: b.version };
  }
}

export function approvalBodySha256(m: Manifest | ApprovalBody): string {
  return canonicalSha256(approvalBody(m));
}

/** SHA-256 of the full canonical manifest: what Nostr events and chain receipts point to. */
export function manifestSha256(m: Manifest): string {
  return canonicalSha256(m);
}

export const APPROVAL_MESSAGE_TYPE = "azaadawaaz/approval@1" as const;

/**
 * The 32-byte message (as hex) a moderator signs to approve. It binds the approval body hash to the approval time,
 * and is domain-separated so the signature can't be replayed as any other kind of signature.
 */
export function approvalMessageHash(bodySha256: string, approvedAt: string): string {
  return canonicalSha256({ type: APPROVAL_MESSAGE_TYPE, body: bodySha256, approvedAt });
}

/** Every original media hash referenced by an approval body, in document order. */
export function mediaHashes(m: Manifest | ApprovalBody): string[] {
  const out: string[] = [];
  if (m.cover) out.push(m.cover.sha256);
  for (const b of m.blocks) {
    if (b.type === "image") for (const i of b.items) out.push(i.sha256);
    if (b.type === "video") out.push(b.source.sha256);
  }
  return out;
}
