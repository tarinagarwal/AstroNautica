/**
 * The staging blob store (docs/architecture.md, "Staging blob store"):
 *
 *   <STAGING_DIR>/<submission id>/<media sha256>/header   24-byte secretstream header
 *   <STAGING_DIR>/<submission id>/<media sha256>/<n>      chunk n (0-based)
 *
 * Every path component is validated (UUID, lowercase sha256 hex, non-negative integer) before it touches the file
 * system, and the resolved path is checked to stay inside the staging directory.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ABYTES, CHUNK_SIZE } from "@azaadawaaz/core";
import { badRequest } from "./errors.js";

export const HEADER_BYTES = 24;
export const MAX_CHUNK_CIPHERTEXT = CHUNK_SIZE + ABYTES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const INT = /^(0|[1-9]\d{0,8})$/;

export const isUuid = (s: string) => UUID.test(s);
export const isSha = (s: string) => SHA.test(s);

/** Parse a chunk index from a URL segment: a canonical non-negative integer. */
export function parseChunkIndex(s: string): number {
  if (!INT.test(s)) throw badRequest("invalid_chunk", "chunk index must be a non-negative integer");
  return Number(s);
}

/** Number of 1 MiB chunks for a plaintext of `size` bytes (an empty file is one empty final chunk). */
export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / CHUNK_SIZE));

/** The exact ciphertext length of chunk `n` of a `size`-byte plaintext. */
export function expectedChunkBytes(size: number, n: number): number {
  const chunks = chunkCount(size);
  return n < chunks - 1 ? CHUNK_SIZE + ABYTES : size - (chunks - 1) * CHUNK_SIZE + ABYTES;
}

export class StagingStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dir(submissionId: string, sha?: string): string {
    if (!isUuid(submissionId)) throw badRequest("invalid_id", "invalid submission id");
    if (sha !== undefined && !isSha(sha)) throw badRequest("invalid_sha256", "invalid media sha256");
    const p = sha === undefined ? join(this.root, submissionId) : join(this.root, submissionId, sha);
    if (!p.startsWith(this.root + sep)) throw badRequest("invalid_path", "invalid path");
    return p;
  }

  private file(submissionId: string, sha: string, name: "header" | number): string {
    return join(this.dir(submissionId, sha), name === "header" ? "header" : String(name));
  }

  private async atomicWrite(path: string, data: Uint8Array): Promise<void> {
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }

  async writeHeader(submissionId: string, sha: string, data: Uint8Array): Promise<void> {
    await mkdir(this.dir(submissionId, sha), { recursive: true, mode: 0o700 });
    await this.atomicWrite(this.file(submissionId, sha, "header"), data);
  }

  async writeChunk(submissionId: string, sha: string, n: number, data: Uint8Array): Promise<void> {
    await mkdir(this.dir(submissionId, sha), { recursive: true, mode: 0o700 });
    await this.atomicWrite(this.file(submissionId, sha, n), data);
  }

  async read(submissionId: string, sha: string, name: "header" | number): Promise<Buffer | undefined> {
    try {
      return await readFile(this.file(submissionId, sha, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** Sizes of what has been received: header (or undefined) and chunk index → byte length. */
  async inventory(submissionId: string, sha: string): Promise<{ header?: number; chunks: Map<number, number> }> {
    const dir = this.dir(submissionId, sha);
    const chunks = new Map<number, number>();
    let header: number | undefined;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { chunks };
      throw e;
    }
    for (const name of names) {
      if (name === "header") header = (await stat(join(dir, name))).size;
      else if (INT.test(name)) chunks.set(Number(name), (await stat(join(dir, name))).size);
    }
    return { header, chunks };
  }

  async removeMedia(submissionId: string, sha: string): Promise<void> {
    await rm(this.dir(submissionId, sha), { recursive: true, force: true });
  }

  async removeSubmission(submissionId: string): Promise<void> {
    await rm(this.dir(submissionId), { recursive: true, force: true });
  }
}
