/**
 * Reviewing a submission (spec §5): unwrap the content key with the moderator's X25519 key, decrypt and check the
 * approval body, decrypt media (each file must hash to the sha256 the body names), then approve, reject or request
 * changes. Approval signs the approval body and re-wraps the content key for the publisher only (decision D2).
 */
import {
  decryptJson,
  unwrapKey,
  wrapKey,
  currentPublisher,
  hexToNpub,
  signApproval,
  type EffectiveLists,
  type EncryptionKeyPair,
} from "@azaadawaaz/core";
import {
  approvalBodySha256,
  mediaHashes,
  validateApprovalBody,
  type Approval,
  type ApprovalBody,
} from "@azaadawaaz/schema";
import { getPublicKey } from "nostr-tools/pure";
import type { Api, ApiConfig, SubmissionDetail } from "../api/client";
import { encryptFeedback } from "../contributor/submissions";
import { createAuditEvent } from "@azaadawaaz/core";

export interface ModeratorIdentity {
  secretKey: Uint8Array;
  pubkey: string;
  x25519: EncryptionKeyPair;
}

export interface OpenedSubmission {
  detail: SubmissionDetail;
  contentKey: Uint8Array;
  body: ApprovalBody;
  problems: string[];
}

/** Checks a moderator does before approving; an empty list means the body matches the submission. */
export function bodyProblems(body: ApprovalBody, detail: SubmissionDetail): string[] {
  const out: string[] = [];
  const v = validateApprovalBody(body);
  if (!v.ok) out.push(...v.errors);
  if (body.id !== detail.storyId) out.push("story id differs from the submission");
  if (body.version !== detail.version) out.push("version differs from the submission");
  if ((body.supersedes ?? null) !== (detail.supersedes ?? null)) out.push("supersedes differs from the submission");
  try {
    if (body.contributor?.pubkey !== hexToNpub(detail.contributor))
      out.push("contributor key differs from the submitter");
  } catch {
    out.push("contributor key is invalid");
  }
  const uploaded = new Set(detail.media.map((m) => m.sha256));
  for (const h of mediaHashes(body)) if (!uploaded.has(h)) out.push(`media ${h.slice(0, 12)}… was not uploaded`);
  return out;
}

export async function openSubmission(api: Api, id: string, me: ModeratorIdentity): Promise<OpenedSubmission> {
  const detail = await api.submission(id, me.x25519.publicKey);
  if (!detail.wrappedKey) throw new Error("this submission has no key wrapped for you yet (ask for a re-wrap)");
  const contentKey = await unwrapKey(detail.wrappedKey, me.x25519);
  const body = await decryptJson<ApprovalBody>(detail.bodyCiphertext, contentKey);
  return { detail, contentKey, body, problems: bodyProblems(body, detail) };
}

/** The publisher's X25519 key from the owner-signed service-keys list; refuses if the API names a different one. */
export function publisherKey(lists: Pick<EffectiveLists, "serviceKeys">, config?: ApiConfig): string {
  const p = currentPublisher(lists);
  if (!p?.x25519) throw new Error("no publisher encryption key on the signed service-keys list");
  if (config?.publisher && config.publisher.pubkey !== p.pubkey)
    throw new Error("the server's publisher differs from the signed service-keys list");
  if (config?.publisher?.x25519 && config.publisher.x25519 !== p.x25519)
    throw new Error("the server's publisher encryption key differs from the signed service-keys list");
  return p.x25519;
}

export async function approve(
  api: Api,
  opened: OpenedSubmission,
  me: ModeratorIdentity,
  lists: Pick<EffectiveLists, "serviceKeys">,
  config?: ApiConfig,
  approvedAt?: string,
): Promise<Approval> {
  if (opened.problems.length) throw new Error(`cannot approve: ${opened.problems.join("; ")}`);
  const approval = signApproval(opened.body, me.secretKey, approvedAt);
  const publisherWrappedKey = await wrapKey(opened.contentKey, publisherKey(lists, config));
  const auditEvent = createAuditEvent(
    { action: "approve", submissionId: opened.detail.id, storyId: opened.detail.storyId },
    me.secretKey,
  );
  await api.approve(opened.detail.id, {
    approval,
    approvalBodySha256: approvalBodySha256(opened.body),
    publisherWrappedKey,
    auditEvent,
  });
  return approval;
}

export async function rejectSubmission(api: Api, detail: SubmissionDetail, me: ModeratorIdentity, reason: string) {
  const text = reason.trim();
  if (!text) throw new Error("a reason is required");
  const feedback = encryptFeedback(text, me.secretKey, detail.contributor);
  const auditEvent = createAuditEvent({ action: "reject", submissionId: detail.id }, me.secretKey);
  return api.reject(detail.id, { feedback, auditEvent });
}

export async function requestChanges(api: Api, detail: SubmissionDetail, me: ModeratorIdentity, notes: string) {
  const text = notes.trim();
  if (!text) throw new Error("notes are required");
  const feedback = encryptFeedback(text, me.secretKey, detail.contributor);
  const auditEvent = createAuditEvent({ action: "request_changes", submissionId: detail.id }, me.secretKey);
  return api.requestChanges(detail.id, { feedback, auditEvent });
}

export function claim(api: Api, id: string, me: ModeratorIdentity) {
  return api.claim(id, createAuditEvent({ action: "claim", submissionId: id }, me.secretKey));
}

/**
 * Add wraps for moderators who joined after a submission was made (spec §5.2 "re-wrap the keys"). Only keys on the
 * signed moderator list (or the owner's) are ever added.
 */
export async function rewrapPending(
  api: Api,
  me: ModeratorIdentity,
  allowed: Set<string>,
): Promise<{ id: string; added: number }[]> {
  const out: { id: string; added: number }[] = [];
  for (const item of await api.rewrapNeeded()) {
    if (!item.wrappedKey) continue;
    const missing = item.missing.filter((k) => allowed.has(k));
    if (!missing.length) continue;
    const key = await unwrapKey(item.wrappedKey, me.x25519);
    const wraps: Record<string, string> = {};
    for (const k of missing) wraps[k] = await wrapKey(key, k);
    const r = await api.addKeys(item.id, wraps);
    out.push({ id: item.id, added: r.added.length });
  }
  return out;
}

export function identityFrom(secretKey: Uint8Array, x25519: EncryptionKeyPair): ModeratorIdentity {
  return { secretKey, pubkey: getPublicKey(secretKey), x25519 };
}
