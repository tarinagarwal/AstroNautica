import {
  approvalBodySha256,
  approvalMessageHash,
  type Approval,
  type ApprovalBody,
  type Manifest,
} from "@azaadawaaz/schema";
import { hexToNpub, signHash, toPubkeyHex, verifyHash } from "./keys.js";
import { getPublicKey } from "nostr-tools/pure";

/** Sign an approval of the given story (manifest or approval body) with a moderator's key. */
export function signApproval(
  story: Manifest | ApprovalBody,
  moderatorSecretKey: Uint8Array,
  approvedAt: string = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): Approval {
  const msg = approvalMessageHash(approvalBodySha256(story), approvedAt);
  return {
    moderator: hexToNpub(getPublicKey(moderatorSecretKey)),
    approvedAt,
    signature: signHash(msg, moderatorSecretKey),
  };
}

/** Check that `approval` is a valid signature by its moderator over this story's approval body. */
export function verifyApprovalSignature(story: Manifest | ApprovalBody, approval: Approval): boolean {
  let pubkey: string;
  try {
    pubkey = toPubkeyHex(approval.moderator);
  } catch {
    return false;
  }
  const msg = approvalMessageHash(approvalBodySha256(story), approval.approvedAt);
  return verifyHash(approval.signature, msg, pubkey);
}
