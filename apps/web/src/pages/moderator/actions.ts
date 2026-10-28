/** Moderation decisions on a submission (spec §5, docs/architecture.md HTTP API). */
import { signApproval } from "@core/approval.js";
import { currentPublisher, type EffectiveLists } from "@core/lists.js";
import { toPubkeyHex } from "@core/keys.js";
import { wrapKey, type EncryptionKeyPair, unwrapKey, wrapKeyFor } from "@core/staging.js";
import { approvalBodySha256 } from "@azaadawaaz/schema";
import type { Api } from "../../lib/api.js";
import type { Signer } from "../../lib/signer.js";
import { createAuditEvent } from "../../data/moderation.js";
import type { OpenedSubmission } from "./preview.js";
import { stagingRecipients } from "../../data/recipients.js";

export class PublisherKeyError extends Error {
  constructor(readonly reason: "missing" | "mismatch") {
    super(`publisher encryption key ${reason}`);
    this.name = "PublisherKeyError";
  }
}

/**
 * The publisher's X25519 key comes from the owner-signed service-keys list. If the API advertises a different key,
 * refuse: wrapping for it would hand the submission to whoever controls the API.
 */
export async function publisherX25519(lists: EffectiveLists, api: Api): Promise<string> {
  const listed = currentPublisher(lists)?.x25519;
  let advertised: string | undefined;
  try {
    advertised = (await api.config()).publisher?.x25519;
  } catch {
    advertised = undefined;
  }
  if (!listed) throw new PublisherKeyError("missing");
  if (advertised && advertised !== listed) throw new PublisherKeyError("mismatch");
  return listed;
}

export async function approve(api: Api, opened: OpenedSubmission, sk: Uint8Array, publisherKey: string) {
  const approval = signApproval(opened.body, sk);
  const body = {
    approval,
    approvalBodySha256: approvalBodySha256(opened.body),
    publisherWrappedKey: await wrapKey(opened.key, publisherKey),
    auditEvent: createAuditEvent(sk, "approve", { submissionId: opened.detail.id, storyId: opened.body.id }),
  };
  await api.approve(opened.detail.id, body);
  return body;
}

/** Reject (final) or request changes; the reason is NIP-44 encrypted to the contributor. */
export async function decide(
  api: Api,
  opened: OpenedSubmission,
  signer: Signer,
  kind: "reject" | "changes",
  text: string,
) {
  const feedback = await signer.nip44Encrypt(toPubkeyHex(opened.detail.contributor), text);
  const auditEvent = createAuditEvent(signer.secretKey!, kind === "reject" ? "reject" : "request_changes", {
    submissionId: opened.detail.id,
  });
  if (kind === "reject") await api.reject(opened.detail.id, { feedback, auditEvent });
  else await api.requestChanges(opened.detail.id, { feedback, auditEvent });
}

/** Add key wraps for moderators added since a submission was made (GET /rewrap-needed → POST keys). */
export async function rewrapAll(
  api: Api,
  lists: EffectiveLists,
  x25519: EncryptionKeyPair,
): Promise<{ done: number; failed: string[] }> {
  const needed = await api.rewrapNeeded();
  const recipients = stagingRecipients(lists);
  let done = 0;
  const failed: string[] = [];
  for (const item of needed) {
    try {
      const detail = await api.submission(item.id, x25519.publicKey);
      if (!detail.wrappedKey) throw new Error("no key for this moderator");
      const key = await unwrapKey(detail.wrappedKey, x25519);
      const targets = item.missing?.length ? item.missing.filter((k) => recipients.includes(k)) : recipients;
      await api.addKeys(item.id, await wrapKeyFor(key, targets));
      done++;
    } catch {
      failed.push(item.id);
    }
  }
  return { done, failed };
}
