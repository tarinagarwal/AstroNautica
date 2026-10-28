/**
 * Moderator preview of encrypted media (spec §5.2): the header and chunks are fetched from the API (authenticated),
 * decrypted with the submission's content key, and the plaintext must hash to the sha256 named in the approval body
 * before it is shown. Small files are decrypted in JS with core's Decryptor; videos are downloaded chunk by chunk to
 * files and decrypted natively.
 */
import { Decryptor, sodiumReady } from "@azaadawaaz/core";
import { sha256Hex } from "@azaadawaaz/schema";
import type { Api, MediaMeta } from "../api/client";
import type { Signer } from "../api/nip98";
import { joinPath, type FileSystem, type Http } from "../platform/types";
import { concatBytes } from "../util/bytes";

export interface ChunkFileDecryptor {
  /** Decrypt chunk files (in order) into dest; resolves with the plaintext hash and size. */
  decryptChunks(header: Uint8Array, key: Uint8Array, chunkPaths: string[], dest: string): Promise<{ sha256: string; size: number }>;
}

export class PreviewIntegrityError extends Error {
  constructor(sha: string) {
    super(`decrypted media does not match its hash ${sha.slice(0, 12)}…`);
    this.name = "PreviewIntegrityError";
  }
}

const IN_MEMORY_LIMIT = 24 * 1024 * 1024;

export async function previewMedia(args: {
  api: Api;
  http: Http;
  fs: FileSystem;
  signer: Signer;
  decryptor: ChunkFileDecryptor;
  submissionId: string;
  media: MediaMeta;
  contentKey: Uint8Array;
  workDir: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<string> {
  const { api, media, submissionId, workDir, fs } = args;
  await fs.mkdirs(workDir);
  const dest = joinPath(workDir, media.sha256);
  const existing = await fs.stat(dest);
  if (existing.exists && (await fs.sha256(dest)) === media.sha256) return dest;
  const header = await api.mediaHeader(submissionId, media.sha256);
  if (media.size <= IN_MEMORY_LIMIT) {
    await sodiumReady();
    const dec = new Decryptor(args.contentKey, header);
    const parts: Uint8Array[] = [];
    for (let n = 0; n < media.chunks; n++) {
      parts.push(dec.pull(await api.mediaChunk(submissionId, media.sha256, n)).data);
      args.onProgress?.(n + 1, media.chunks);
    }
    if (!dec.done) throw new Error("stream truncated: final chunk missing");
    const plain = concatBytes(parts);
    if (sha256Hex(plain) !== media.sha256) throw new PreviewIntegrityError(media.sha256);
    await fs.writeBytes(dest, plain);
    return dest;
  }
  const chunkDir = joinPath(workDir, `${media.sha256}.chunks`);
  await fs.mkdirs(chunkDir);
  const paths: string[] = [];
  for (let n = 0; n < media.chunks; n++) {
    const path = joinPath(chunkDir, String(n));
    const url = api.url(`/submissions/${submissionId}/media/${media.sha256}/chunks/${n}`);
    const st = await fs.stat(path);
    if (!st.exists) {
      await args.http.download({
        url,
        dest: path,
        headers: { authorization: args.signer.authHeader(url, "GET") },
        maxBytes: 1024 * 1024 + 17,
      });
    }
    paths.push(path);
    args.onProgress?.(n + 1, media.chunks);
  }
  const r = await args.decryptor.decryptChunks(header, args.contentKey, paths, dest);
  await fs.remove(chunkDir).catch(() => undefined);
  if (r.sha256 !== media.sha256) {
    await fs.remove(dest).catch(() => undefined);
    throw new PreviewIntegrityError(media.sha256);
  }
  return dest;
}
