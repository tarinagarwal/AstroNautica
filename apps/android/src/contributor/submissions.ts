/**
 * Submission status and moderator feedback (spec §5.1, §8.2): feedback is NIP-44 encrypted by the moderator to the
 * contributor's key and decrypted only on the contributor's device.
 */
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import type { Feedback, MySubmission, SubmissionState } from "../api/client";

export interface DecryptedFeedback {
  at: string;
  moderator: string;
  kind: "reject" | "changes";
  text: string | null;
  error?: string;
}

export function decryptFeedback(f: Feedback, contributorSecretKey: Uint8Array): DecryptedFeedback {
  try {
    const key = getConversationKey(contributorSecretKey, f.moderator);
    return { at: f.at, moderator: f.moderator, kind: f.kind, text: decrypt(f.nip44, key) };
  } catch (e) {
    return { at: f.at, moderator: f.moderator, kind: f.kind, text: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Moderator side: encrypt feedback text to the contributor (hex pubkey). */
export function encryptFeedback(text: string, moderatorSecretKey: Uint8Array, contributorPubkey: string): string {
  return encrypt(text, getConversationKey(moderatorSecretKey, contributorPubkey));
}

/** States in which the contributor may edit and resubmit. */
export const EDITABLE: SubmissionState[] = ["draft", "changes_requested"];

export function canEdit(s: Pick<MySubmission, "state">): boolean {
  return EDITABLE.includes(s.state);
}

/** i18n key for a state label. */
export const stateKey = (s: SubmissionState) => `submission.state.${s}`;
