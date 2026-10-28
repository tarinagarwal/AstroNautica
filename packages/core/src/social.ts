import { verifyEventStrict } from "./keys.js";
import { finalizeEvent, getEventHash, type Event, type EventTemplate } from "nostr-tools/pure";
import { getPublicKey } from "nostr-tools/pure";
import { getPow } from "nostr-tools/nip13";
import { KIND_COMMENT, KIND_REACTION, KIND_STORY } from "./kinds.js";
import type { EffectiveLists } from "./lists.js";
import type { StoryRef } from "./stories.js";

export const MAX_COMMENT_CHARS = 2000;
export const DEFAULT_POW_DIFFICULTY = 16;
/** Supported reactions (spec §7). "⭐" means "important". */
export const REACTIONS = ["👍", "❤️", "😮", "😢", "😡", "🙏", "⭐"] as const;
export type Reaction = (typeof REACTIONS)[number];

/**
 * Mine NIP-13 proof-of-work and sign. Yields to the event loop periodically so a browser UI stays responsive; in the
 * web app this runs in a Web Worker anyway.
 */
export async function mineAndSign(
  template: EventTemplate,
  secretKey: Uint8Array,
  difficulty: number,
  opts: { signal?: AbortSignal; yieldEvery?: number } = {},
): Promise<Event> {
  const pubkey = getPublicKey(secretKey);
  const base = template.tags.filter((t) => t[0] !== "nonce");
  const yieldEvery = opts.yieldEvery ?? 5000;
  let nonce = 0;
  let createdAt = template.created_at;
  for (;;) {
    for (let i = 0; i < yieldEvery; i++, nonce++) {
      const tags = [...base, ["nonce", String(nonce), String(difficulty)]];
      const id = getEventHash({ ...template, created_at: createdAt, tags, pubkey });
      if (getPow(id) >= difficulty) {
        return finalizeEvent({ ...template, created_at: createdAt, tags }, secretKey);
      }
    }
    if (opts.signal?.aborted) throw new Error("aborted");
    await new Promise((r) => setTimeout(r, 0));
    createdAt = Math.floor(Date.now() / 1000);
  }
}

/** The PoW an event actually has, counting only if it committed to at least that target (NIP-13). */
export function committedPow(e: Event): number {
  const nonce = e.tags.find((t) => t[0] === "nonce");
  const target = Number(nonce?.[2] ?? 0);
  return Math.min(getPow(e.id), Number.isFinite(target) ? target : 0);
}

function storyRootTags(story: Pick<StoryRef, "address" | "eventId" | "publisher">, relayHint = ""): string[][] {
  return [
    ["A", story.address, relayHint],
    ["K", String(KIND_STORY)],
    ["P", story.publisher, relayHint],
  ];
}

/** Build a NIP-22 comment on a story, or a reply to another comment. */
export function commentTemplate(args: {
  story: Pick<StoryRef, "address" | "eventId" | "publisher">;
  content: string;
  parent?: Event;
  relayHint?: string;
  createdAt?: number;
}): EventTemplate {
  const content = args.content.trim();
  if (!content) throw new Error("comment is empty");
  if ([...content].length > MAX_COMMENT_CHARS)
    throw new Error(`comment is longer than ${MAX_COMMENT_CHARS} characters`);
  const hint = args.relayHint ?? "";
  const parentTags = args.parent
    ? [
        ["e", args.parent.id, hint, args.parent.pubkey],
        ["k", String(KIND_COMMENT)],
        ["p", args.parent.pubkey, hint],
      ]
    : [
        ["a", args.story.address, hint],
        ["e", args.story.eventId, hint],
        ["k", String(KIND_STORY)],
        ["p", args.story.publisher, hint],
      ];
  return {
    kind: KIND_COMMENT,
    created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [...storyRootTags(args.story, hint), ...parentTags],
    content,
  };
}

export function reactionTemplate(args: {
  story: Pick<StoryRef, "address" | "eventId" | "publisher">;
  reaction: Reaction;
  createdAt?: number;
}): EventTemplate {
  if (!REACTIONS.includes(args.reaction)) throw new Error("unsupported reaction");
  return {
    kind: KIND_REACTION,
    created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ["a", args.story.address],
      ["e", args.story.eventId],
      ["p", args.story.publisher],
      ["k", String(KIND_STORY)],
    ],
    content: args.reaction,
  };
}

export interface CommentNode {
  event: Event;
  replies: CommentNode[];
}

type Moderation = Pick<EffectiveLists, "hidden" | "muted">;

/**
 * Comments to show for a story: valid signature, rooted at this story, within length, enough committed PoW, not
 * hidden, author not muted. Returned as a thread tree, oldest first. Replies whose parent is missing or hidden are
 * dropped with it.
 */
export function buildCommentThread(
  events: Event[],
  storyAddress: string,
  lists: Moderation,
  minPow: number = DEFAULT_POW_DIFFICULTY,
): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const e of events) {
    if (e?.kind !== KIND_COMMENT || nodes.has(e.id)) continue;
    if (e.tags.find((t) => t[0] === "A")?.[1] !== storyAddress) continue;
    if ([...e.content].length > MAX_COMMENT_CHARS || !e.content.trim()) continue;
    if (lists.hidden.has(e.id) || lists.muted.has(e.pubkey)) continue;
    if (committedPow(e) < minPow) continue;
    if (!verifyEventStrict(e)) continue;
    nodes.set(e.id, { event: e, replies: [] });
  }
  const roots: CommentNode[] = [];
  for (const n of nodes.values()) {
    const k = n.event.tags.find((t) => t[0] === "k")?.[1];
    if (k === String(KIND_COMMENT)) {
      const parentId = n.event.tags.find((t) => t[0] === "e")?.[1];
      const parent = parentId ? nodes.get(parentId) : undefined;
      if (parent) parent.replies.push(n);
    } else {
      roots.push(n);
    }
  }
  const sort = (xs: CommentNode[]) => {
    xs.sort((a, b) => a.event.created_at - b.event.created_at || (a.event.id < b.event.id ? -1 : 1));
    xs.forEach((x) => sort(x.replies));
    return xs;
  };
  return sort(roots);
}

/** Count reactions: one per (pubkey, reaction). */
export function countReactions(
  events: Event[],
  storyAddress: string,
  lists: Pick<EffectiveLists, "muted">,
  minPow: number = DEFAULT_POW_DIFFICULTY,
): Record<Reaction, number> & { mine?: Set<Reaction> } {
  const counts = Object.fromEntries(REACTIONS.map((r) => [r, 0])) as Record<Reaction, number>;
  const seen = new Set<string>();
  for (const e of events) {
    if (e?.kind !== KIND_REACTION) continue;
    if (!REACTIONS.includes(e.content as Reaction)) continue;
    if (e.tags.find((t) => t[0] === "a")?.[1] !== storyAddress) continue;
    if (lists.muted.has(e.pubkey) || committedPow(e) < minPow) continue;
    const key = `${e.pubkey}|${e.content}`;
    if (seen.has(key) || !verifyEventStrict(e)) continue;
    seen.add(key);
    counts[e.content as Reaction]++;
  }
  return counts;
}

export function myReactions(events: Event[], storyAddress: string, pubkey: string): Set<Reaction> {
  return new Set(
    events
      .filter(
        (e) =>
          e.kind === KIND_REACTION && e.pubkey === pubkey && e.tags.find((t) => t[0] === "a")?.[1] === storyAddress,
      )
      .map((e) => e.content as Reaction)
      .filter((r) => REACTIONS.includes(r)),
  );
}
