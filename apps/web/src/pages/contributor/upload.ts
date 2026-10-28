/**
 * Encrypt and upload a submission (spec §5.2, docs/architecture.md): a content key per submission, the approval body
 * sealed with `encryptJson`, each media file encrypted with secretstream in 1 MiB chunks, the key wrapped for the
 * owner and every active moderator (X25519 keys taken from the signed lists, never from the API alone). Encrypted
 * chunks are kept in IndexedDB until the upload completes, so an interrupted upload resumes where it stopped (the
 * status endpoint says which chunks the server already has).
 */
export { RecipientsError } from "../../data/recipients.js";
import { CHUNK_SIZE, Encryptor, encryptJson, newContentKey, sodiumReady, wrapKeyFor } from "@core/staging.js";
import type { EffectiveLists } from "@core/lists.js";
import { stagingRecipients } from "../../data/recipients.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { idbDel, idbGet, idbKeys, idbSet } from "../../lib/idb.js";
import type { Api, SubmissionInput } from "../../lib/api.js";
import { buildApprovalBody, loadMediaBytes, saveDraft, usedMedia, type Draft } from "./draft.js";

export interface UploadProgress {
  phase: "encrypting" | "uploading" | "submitting" | "done";
  done: number;
  total: number;
}

interface UploadState {
  submissionId: string;
  key: string; // hex content key (the contributor's own; the plaintext is on this device anyway)
}

const stateKey = (d: Draft) => `upload:${d.storyId}:${d.version}`;
const encKey = (id: string, sha: string, part: string) => `enc:${id}:${sha}:${part}`;

/** Encrypt one file into IndexedDB (header + chunks), unless already done for this submission. */
async function encryptToStore(
  id: string,
  sha: string,
  bytes: Uint8Array,
  key: Uint8Array,
): Promise<{ fresh: boolean }> {
  const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));
  const have = await idbGet<{ chunks: number }>(encKey(id, sha, "meta"));
  if (have?.chunks === chunks) return { fresh: false };
  await sodiumReady();
  const enc = new Encryptor(key);
  await idbSet(encKey(id, sha, "h"), enc.header);
  for (let n = 0; n < chunks; n++) {
    const part = bytes.subarray(n * CHUNK_SIZE, Math.min((n + 1) * CHUNK_SIZE, bytes.length));
    await idbSet(encKey(id, sha, String(n)), enc.push(part, n === chunks - 1));
  }
  await idbSet(encKey(id, sha, "meta"), { chunks });
  return { fresh: true };
}

async function clearEncrypted(id: string): Promise<void> {
  for (const k of await idbKeys(`enc:${id}:`)) await idbDel(k);
}

export async function hasPendingUpload(d: Draft): Promise<boolean> {
  return !!(await idbGet<UploadState>(stateKey(d)));
}

/**
 * Create (or update) the submission, upload every media chunk the server is missing, and submit it.
 * Safe to call again after a failure: it continues from what is already stored.
 */
export async function uploadAndSubmit(
  draft: Draft,
  contributorNpub: string,
  api: Api,
  lists: EffectiveLists,
  onProgress: (p: UploadProgress) => void,
): Promise<string> {
  const body = buildApprovalBody(draft, contributorNpub);
  const recipients = stagingRecipients(lists);
  let state = await idbGet<UploadState>(stateKey(draft));
  const key = state ? hexToBytes(state.key) : await newContentKey();

  onProgress({ phase: "encrypting", done: 0, total: 1 });
  const media = usedMedia(draft);
  const input: SubmissionInput = {
    storyId: draft.storyId,
    version: draft.version,
    supersedes: draft.supersedes,
    bodyCiphertext: await encryptJson(body, key),
    wrappedKeys: await wrapKeyFor(key, recipients),
    media: media.map((m) => ({
      sha256: m.sha256,
      size: m.size,
      mime: m.mime,
      kind: m.kind,
      chunks: Math.max(1, Math.ceil(m.size / CHUNK_SIZE)),
    })),
  };

  const existingId = state?.submissionId ?? draft.submissionId;
  let id: string;
  if (existingId) {
    await api.updateSubmission(existingId, input);
    id = existingId;
  } else {
    id = (await api.createSubmission(input)).id;
  }
  state = { submissionId: id, key: bytesToHex(key) };
  await idbSet(stateKey(draft), state);
  if (draft.submissionId !== id) await saveDraft({ ...draft, submissionId: id });

  // Per file: skip what the server already has; otherwise encrypt into IndexedDB (stable ciphertext, so a resumed
  // upload sends the same bytes) and upload only the chunks the server is missing.
  const totalChunks = input.media.reduce((n, m) => n + m.chunks, 0);
  let doneChunks = 0;
  for (const m of input.media) {
    const status = await api.mediaStatus(id, m.sha256).catch(() => ({ received: [] as number[], complete: false }));
    if (status.complete) {
      doneChunks += m.chunks;
      onProgress({ phase: "uploading", done: doneChunks, total: totalChunks });
      continue;
    }
    onProgress({ phase: "encrypting", done: doneChunks, total: totalChunks });
    const bytes = await loadMediaBytes(m.sha256);
    if (!bytes) throw new Error(`media ${m.sha256} is missing from this device`);
    // Newly encrypted bytes don't match chunks uploaded earlier with another header: send every chunk again.
    const { fresh } = await encryptToStore(id, m.sha256, bytes, key);
    const header = await idbGet<Uint8Array>(encKey(id, m.sha256, "h"));
    if (!header) throw new Error("encrypted header missing");
    await api.putHeader(id, m.sha256, header);
    const received = new Set(fresh ? [] : status.received);
    for (let n = 0; n < m.chunks; n++) {
      if (!received.has(n)) {
        const chunk = await idbGet<Uint8Array>(encKey(id, m.sha256, String(n)));
        if (!chunk) throw new Error("encrypted chunk missing");
        await api.putChunk(id, m.sha256, n, chunk);
      }
      doneChunks++;
      onProgress({ phase: "uploading", done: doneChunks, total: totalChunks });
    }
    await api.completeMedia(id, m.sha256);
  }

  onProgress({ phase: "submitting", done: 0, total: 1 });
  await api.submit(id);
  await clearEncrypted(id);
  // Keep the content key with the submission id in case the contributor edits after a change request.
  onProgress({ phase: "done", done: 1, total: 1 });
  return id;
}
