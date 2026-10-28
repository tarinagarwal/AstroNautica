/**
 * Submitting a draft (spec §5.2, docs/architecture.md): encrypt the approval body with a fresh content key, wrap the
 * key for the owner and every moderator (keys from GET /config, each checked against the owner-signed lists), encrypt
 * each media file into 1 MiB secretstream chunks on the device, then upload with resume.
 *
 * Every step is recorded in a persisted state, so an interrupted submission continues where it stopped: encrypted
 * chunks are kept until the upload completes (a resumed upload must send the same ciphertext the server already
 * holds part of), and the server's `/status` decides which chunks are still missing.
 */
import { CHUNK_SIZE, encryptJson, wrapKeyFor, type EffectiveLists } from "@azaadawaaz/core";
import type { ApprovalBody } from "@azaadawaaz/schema";
import type { Api, ApiConfig, SubmissionInput } from "../api/client";
import type { DraftMedia } from "./draft";

export interface EncryptedChunk {
  n: number;
  /** Ciphertext size (≤ 1 MiB + 17). */
  size: number;
  sha256: string;
  path: string;
}

export interface EncryptedMedia {
  header: Uint8Array;
  chunks: EncryptedChunk[];
  plainSha256: string;
  plainSize: number;
}

export interface UploadDeps {
  api: Api;
  /** Encrypt a file into chunk files under outDir (native secretstream; same format as core `encryptBytes`). */
  encryptFile(src: string, outDir: string, key: Uint8Array, chunkSize: number): Promise<EncryptedMedia>;
  removeDir(dir: string): Promise<void>;
  /** Persist and load the state of each submission in progress (survives app restarts). */
  saveState(state: UploadState): Promise<void>;
  workDir: string;
  onProgress?: (p: UploadProgress) => void;
}

export interface MediaUploadState {
  sha256: string;
  size: number;
  mime: string;
  kind: "image" | "video";
  path: string;
  dir: string;
  headerB64?: string;
  chunks?: EncryptedChunk[];
  done: boolean;
}

export interface UploadState {
  draftId: string;
  submissionId?: string;
  phase: "start" | "encrypted" | "created" | "uploaded" | "submitted";
  /** Base64 of the content key. Stored with the encrypted keys vault, never sent anywhere. */
  contentKeyB64: string;
  bodyCiphertext?: string;
  wrappedKeys?: Record<string, string>;
  media: MediaUploadState[];
  storyId: string;
  version: number;
  supersedes: string | null;
}

export interface UploadProgress {
  phase: UploadState["phase"] | "encrypting" | "uploading";
  sentChunks: number;
  totalChunks: number;
}

export class KeyCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyCheckError";
  }
}

/**
 * The X25519 keys to wrap the content key for: exactly the owner's and every active moderator's key from GET /config,
 * after checking each against the owner-signed lists. A server that adds a key not on the signed lists (to read
 * submissions) or leaves out a moderator is refused.
 */
export function recipientsFor(
  config: ApiConfig,
  lists: Pick<EffectiveLists, "moderators" | "activeModerators" | "serviceKeys" | "owner">,
): string[] {
  const signedOwner = lists.serviceKeys.find((k) => k.role === "owner" && k.pubkey === lists.owner && !k.until)?.x25519;
  const signedMods = new Map(
    lists.moderators.filter((m) => lists.activeModerators.has(m.pubkey)).map((m) => [m.pubkey, m.x25519]),
  );
  if (!config.ownerX25519) throw new KeyCheckError("the server did not provide the owner's encryption key");
  if (config.ownerPubkey !== lists.owner) throw new KeyCheckError("the server's owner key differs from the pinned key");
  if (signedOwner && config.ownerX25519 !== signedOwner)
    throw new KeyCheckError("the owner's encryption key differs from the signed service-keys list");
  const out = [config.ownerX25519];
  for (const m of config.moderators) {
    if (signedMods.get(m.pubkey) !== m.x25519)
      throw new KeyCheckError(`moderator key ${m.pubkey.slice(0, 12)}… is not on the signed moderator list`);
    out.push(m.x25519);
  }
  for (const [pubkey, x] of signedMods)
    if (!out.includes(x)) throw new KeyCheckError(`the server left out moderator ${pubkey.slice(0, 12)}…`);
  return [...new Set(out)];
}

export function newUploadState(args: {
  draftId: string;
  contentKey: Uint8Array;
  storyId: string;
  version: number;
  supersedes: string | null;
  media: DraftMedia[];
  workDir: string;
  submissionId?: string;
  toB64: (b: Uint8Array) => string;
}): UploadState {
  return {
    draftId: args.draftId,
    submissionId: args.submissionId,
    phase: "start",
    contentKeyB64: args.toB64(args.contentKey),
    storyId: args.storyId,
    version: args.version,
    supersedes: args.supersedes,
    media: args.media.map((m) => ({ ...m, dir: `${args.workDir}/${m.sha256}`, done: false })),
  };
}

/**
 * Run (or resume) a submission until it is submitted. `body` must be the draft's approval body; `recipients` the
 * checked X25519 keys. Throws on errors; the saved state lets a later call continue.
 */
export async function runUpload(
  state: UploadState,
  body: ApprovalBody,
  recipients: string[],
  contentKey: Uint8Array,
  deps: UploadDeps,
  codec: { toB64: (b: Uint8Array) => string; fromB64: (s: string) => Uint8Array },
): Promise<UploadState> {
  const s: UploadState = structuredClone(state);
  const save = () => deps.saveState(s);
  const totalChunks = () => s.media.reduce((n, m) => n + (m.chunks?.length ?? 0), 0);
  let sent = 0;
  const progress = (phase: UploadProgress["phase"]) =>
    deps.onProgress?.({ phase, sentChunks: sent, totalChunks: totalChunks() });

  // 1. Encrypt body, wrap keys, encrypt media into chunk files (once; reused on resume).
  if (s.phase === "start") {
    progress("encrypting");
    s.bodyCiphertext = await encryptJson(body, contentKey);
    s.wrappedKeys = await wrapKeyFor(contentKey, recipients);
    for (const m of s.media) {
      if (m.chunks) continue;
      const enc = await deps.encryptFile(m.path, m.dir, contentKey, CHUNK_SIZE);
      if (enc.plainSha256 !== m.sha256 || enc.plainSize !== m.size)
        throw new Error(`media ${m.sha256.slice(0, 12)}… changed on the device since it was stripped`);
      m.headerB64 = codec.toB64(enc.header);
      m.chunks = enc.chunks;
      await save();
    }
    s.phase = "encrypted";
    await save();
  }

  const input = (): SubmissionInput => ({
    storyId: s.storyId,
    version: s.version,
    supersedes: s.supersedes,
    bodyCiphertext: s.bodyCiphertext!,
    wrappedKeys: s.wrappedKeys!,
    media: s.media.map((m) => ({
      sha256: m.sha256,
      size: m.size,
      mime: m.mime,
      kind: m.kind,
      chunks: m.chunks!.length,
    })),
  });

  // 2. Create the submission, or replace the body and media list of an existing one (edit after change requests).
  if (s.phase === "encrypted") {
    if (s.submissionId) await deps.api.updateSubmission(s.submissionId, input());
    else s.submissionId = (await deps.api.createSubmission(input())).id;
    s.phase = "created";
    await save();
  }

  // 3. Upload each media file: header, then only the chunks the server doesn't have, then "complete".
  if (s.phase === "created") {
    const id = s.submissionId!;
    for (const m of s.media) {
      if (m.done) {
        sent += m.chunks!.length;
        continue;
      }
      const status = await deps.api.mediaStatus(id, m.sha256);
      if (status.complete) {
        m.done = true;
        sent += m.chunks!.length;
        await save();
        continue;
      }
      const have = new Set(status.received);
      if (status.header !== true) await deps.api.putHeader(id, m.sha256, codec.fromB64(m.headerB64!));
      sent += have.size;
      progress("uploading");
      for (const c of m.chunks!) {
        if (have.has(c.n)) continue;
        await deps.api.putChunkFile(id, m.sha256, c.n, c.path, c.sha256);
        sent++;
        progress("uploading");
      }
      // If the server still misses something it answers media_incomplete; the next resume re-reads /status.
      await deps.api.completeMedia(id, m.sha256);
      m.done = true;
      await save();
    }
    s.phase = "uploaded";
    await save();
  }

  // 4. Submit for moderation, then drop the local ciphertext.
  if (s.phase === "uploaded") {
    await deps.api.submit(s.submissionId!);
    s.phase = "submitted";
    await save();
    for (const m of s.media) await deps.removeDir(m.dir).catch(() => undefined);
    progress("submitted");
  }
  return s;
}
