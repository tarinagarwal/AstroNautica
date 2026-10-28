/**
 * Moderator preview of an unpublished submission (spec §5.2): unwrap the content key with the moderator's X25519
 * key, decrypt the approval body, and stream-decrypt media chunk by chunk into object URLs. Every media file must
 * hash to the SHA-256 in the approval body, so the moderator sees exactly what they sign.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Decryptor, decryptJson, sodiumReady, unwrapKey, type EncryptionKeyPair } from "@core/staging.js";
import { toPubkeyHex } from "@core/keys.js";
import { mediaHashes, validateApprovalBody, type ApprovalBody } from "@azaadawaaz/schema";
import type { Api, MediaMeta, SubmissionDetail } from "../../lib/api.js";
import type { PreviewMedia } from "../../components/StoryView.js";

export class PreviewError extends Error {
  constructor(
    readonly code: "no-key" | "invalid-body" | "mismatch" | "media-missing",
    detail = "",
  ) {
    super(detail || code);
    this.name = "PreviewError";
  }
}

export interface OpenedSubmission {
  detail: SubmissionDetail;
  key: Uint8Array;
  body: ApprovalBody;
}

export async function openSubmission(api: Api, id: string, x25519: EncryptionKeyPair): Promise<OpenedSubmission> {
  const detail = await api.submission(id, x25519.publicKey);
  if (!detail.wrappedKey) throw new PreviewError("no-key");
  const key = await unwrapKey(detail.wrappedKey, x25519);
  const body = await decryptJson<ApprovalBody>(detail.bodyCiphertext, key);
  const v = validateApprovalBody(body);
  if (!v.ok) throw new PreviewError("invalid-body", v.errors.join("; "));
  // The encrypted body must describe this submission: same story, version, supersedes and contributor.
  let contributorOk = false;
  try {
    contributorOk = toPubkeyHex(body.contributor.pubkey) === toPubkeyHex(detail.contributor);
  } catch {
    contributorOk = false;
  }
  if (
    body.id !== detail.storyId ||
    body.version !== detail.version ||
    (body.supersedes ?? null) !== (detail.supersedes ?? null) ||
    !contributorOk
  )
    throw new PreviewError("mismatch");
  const have = new Set(detail.media.map((m) => m.sha256));
  const missing = mediaHashes(body).filter((h) => !have.has(h));
  if (missing.length) throw new PreviewError("media-missing", missing.join(", "));
  return { detail, key, body };
}

/** Decrypt one media file chunk by chunk, checking its hash; returns the plaintext as a Blob. */
export async function decryptMedia(
  api: Api,
  id: string,
  meta: MediaMeta,
  key: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  await sodiumReady();
  const header = await api.mediaHeader(id, meta.sha256);
  const dec = new Decryptor(key, header);
  const hash = sha256.create();
  const parts: Uint8Array[] = [];
  for (let n = 0; n < meta.chunks; n++) {
    const { data } = dec.pull(await api.mediaChunk(id, meta.sha256, n));
    hash.update(data);
    parts.push(data);
    onProgress?.(n + 1, meta.chunks);
  }
  if (!dec.done) throw new PreviewError("mismatch", "stream truncated");
  if (bytesToHex(hash.digest()) !== meta.sha256) throw new PreviewError("mismatch", meta.sha256);
  return new Blob(parts as BlobPart[], { type: meta.mime });
}

/** Media resolver for `StoryBody` previews; each file is decrypted once and kept as an object URL. */
export function previewMedia(
  api: Api,
  opened: OpenedSubmission,
  onProgress?: (sha: string, done: number, total: number) => void,
) {
  const cache = new Map<string, Promise<string>>();
  const urls: string[] = [];
  const media: PreviewMedia = {
    url(sha) {
      let p = cache.get(sha);
      if (!p) {
        const meta = opened.detail.media.find((m) => m.sha256 === sha);
        p = meta
          ? decryptMedia(api, opened.detail.id, meta, opened.key, (d, t) => onProgress?.(sha, d, t)).then((b) => {
              const u = URL.createObjectURL(b);
              urls.push(u);
              return u;
            })
          : Promise.reject(new PreviewError("media-missing", sha));
        cache.set(sha, p);
      }
      return p;
    },
  };
  return { media, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}
