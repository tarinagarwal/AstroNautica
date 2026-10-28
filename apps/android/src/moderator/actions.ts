/**
 * Moderator actions that change signed lists (spec §3, §5.3, §5.4, §7): each edits the moderator's own copy of a
 * moderator-tier list, signs it, publishes it to every relay, and records a signed audit event (kind 9737) with the
 * API. Relays are what clients read, so the list goes out first; the audit call can be retried if the API is down.
 */
import {
  KIND_APP_DATA,
  KIND_AUDIT,
  createListEvent,
  editModeratorList,
  listD,
  parseListEvent,
  type Event,
  type ModeratorListItem,
  type ModeratorListName,
  type PublishResult,
} from "@azaadawaaz/core";
import { sha256Hex } from "@azaadawaaz/schema";
import { finalizeEvent } from "nostr-tools/pure";
import type { Api } from "../api/client";
import type { AppData } from "../data/appData";

export type AuditAction =
  | "approve"
  | "reject"
  | "request_changes"
  | "unlist"
  | "hide"
  | "mute"
  | "claim"
  | "revoke_contributor";

/** A moderator-signed audit event: kind 9737, tags per docs/architecture.md, empty content. */
export function createAuditEvent(
  secretKey: Uint8Array,
  action: AuditAction,
  opts: { submissionId?: string; storyId?: string; extraTags?: string[][]; createdAt?: number } = {},
): Event {
  const tags: string[][] = [["action", action]];
  if (opts.submissionId) tags.push(["s", sha256Hex(opts.submissionId.toLowerCase())]);
  if (opts.storyId && (action === "approve" || action === "unlist")) tags.push(["story", opts.storyId.toLowerCase()]);
  tags.push(...(opts.extraTags ?? []));
  return finalizeEvent(
    { kind: KIND_AUDIT, created_at: opts.createdAt ?? Math.floor(Date.now() / 1000), tags, content: "" },
    secretKey,
  );
}

/** The newest copy of this signer's list, from what we hold and what relays have now. */
export async function currentItems(app: AppData, author: string, name: ModeratorListName): Promise<ModeratorListItem[]> {
  const remote = await app.pool
    .query(app.relayUrls(), { kinds: [KIND_APP_DATA], authors: [author], "#d": [listD(name)] })
    .catch(() => [] as Event[]);
  app.acceptListEvents(remote);
  const latest = app.latestListEvent(author, name);
  const parsed = latest ? parseListEvent(latest) : null;
  return (parsed?.items as ModeratorListItem[] | undefined) ?? [];
}

export interface ListChange {
  event: Event;
  relays: PublishResult[];
}

/** Add or remove values in the moderator's own list, sign, publish to every relay. */
export async function changeList(
  app: AppData,
  secretKey: Uint8Array,
  author: string,
  name: ModeratorListName,
  changes: { op: "add" | "remove"; value: string }[],
): Promise<ListChange> {
  let items = await currentItems(app, author, name);
  for (const c of changes) items = editModeratorList(items, c.op, c.value);
  // created_at must move forward even within the same second, or relays keep the older copy.
  const prev = app.latestListEvent(author, name);
  const now = Math.max(Math.floor(Date.now() / 1000), (prev?.created_at ?? 0) + 1);
  const event = createListEvent(name, items, secretKey, now);
  const relays = await app.publish(event);
  app.acceptListEvents([event]);
  return { event, relays };
}

export interface ModResult extends ListChange {
  audit: Event;
  /** Set when the API could not record the audit event. */
  auditError?: string;
}

async function record(api: Api | null, fn: (api: Api) => Promise<unknown>): Promise<string | undefined> {
  if (!api) return "no API configured";
  try {
    await fn(api);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function hideComment(app: AppData, api: Api | null, sk: Uint8Array, me: string, commentId: string): Promise<ModResult> {
  const change = await changeList(app, sk, me, "hidden", [{ op: "add", value: commentId }]);
  const audit = createAuditEvent(sk, "hide", { extraTags: [["e", commentId]] });
  return { ...change, audit, auditError: await record(api, (a) => a.audit(audit)) };
}

export async function muteKey(app: AppData, api: Api | null, sk: Uint8Array, me: string, pubkey: string): Promise<ModResult> {
  const change = await changeList(app, sk, me, "muted", [{ op: "add", value: pubkey }]);
  const audit = createAuditEvent(sk, "mute", { extraTags: [["p", pubkey]] });
  return { ...change, audit, auditError: await record(api, (a) => a.audit(audit)) };
}

export async function unlistStory(app: AppData, api: Api | null, sk: Uint8Array, me: string, storyId: string): Promise<ModResult> {
  const change = await changeList(app, sk, me, "unlisted", [{ op: "add", value: storyId }]);
  const audit = createAuditEvent(sk, "unlist", { storyId });
  return { ...change, audit, auditError: await record(api, (a) => a.unlist(storyId, audit)) };
}

export function setFeatured(app: AppData, sk: Uint8Array, me: string, storyId: string, on: boolean): Promise<ListChange> {
  return changeList(app, sk, me, "featured", [{ op: on ? "add" : "remove", value: storyId }]);
}

/**
 * Bring this moderator's signed contributor lists in line with the API's contributor table (spec §3.1 step 3): newly
 * redeemed contributors are added, revoked ones go on the revoked list. Returns what changed.
 */
export async function syncContributors(
  app: AppData,
  api: Api,
  sk: Uint8Array,
  me: string,
): Promise<{ added: string[]; revoked: string[] }> {
  const rows = await api.contributors();
  const current = new Set((await currentItems(app, me, "contributors")).map(([v]) => v));
  const revokedNow = new Set((await currentItems(app, me, "revoked-contributors")).map(([v]) => v));
  const added = rows.filter((r) => !r.revokedAt && !current.has(r.pubkey) && !revokedNow.has(r.pubkey)).map((r) => r.pubkey);
  const revoked = rows.filter((r) => r.revokedAt && !revokedNow.has(r.pubkey)).map((r) => r.pubkey);
  if (added.length) await changeList(app, sk, me, "contributors", added.map((value) => ({ op: "add" as const, value })));
  if (revoked.length)
    await changeList(app, sk, me, "revoked-contributors", revoked.map((value) => ({ op: "add" as const, value })));
  return { added, revoked };
}
