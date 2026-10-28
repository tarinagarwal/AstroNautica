/**
 * Chunked, resumable upload of encrypted media into the staging store, and authenticated download for moderators.
 * Chunk sizes are checked exactly: chunk n of a `size`-byte plaintext is 1 MiB + 17 bytes, except the last one.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { caller, type Ctx } from "../context.js";
import { withTx } from "../db.js";
import { HttpError, badRequest, conflict, notFound } from "../errors.js";
import { TransitionError, canTransition, transition, type MediaItem, type SubmissionRow } from "../stateMachine.js";
import { loadSubmission, parseId, readAccess } from "../submissions.js";
import { HEADER_BYTES, expectedChunkBytes, isSha, parseChunkIndex } from "../staging.js";

type MediaParams = { id: string; sha256: string };
type ChunkParams = MediaParams & { n: string };

function parseSha(s: string): string {
  if (!isSha(s)) throw badRequest("invalid_sha256", "media sha256 must be 64 lowercase hex characters");
  return s;
}

function findMedia(row: SubmissionRow, sha: string): MediaItem {
  const m = row.media.find((x) => x.sha256 === sha);
  if (!m) throw notFound("media");
  return m;
}

function rawBytes(req: FastifyRequest): Buffer {
  if (!Buffer.isBuffer(req.body))
    throw new HttpError(415, "unsupported_media_type", "send the bytes as application/octet-stream");
  return req.body;
}

function withComplete(media: MediaItem[], sha: string, complete: boolean): MediaItem[] {
  return media.map((m) => (m.sha256 === sha ? { ...m, complete } : m));
}

export function mediaRoutes(app: FastifyInstance, ctx: Ctx): void {
  const writer = { preHandler: [ctx.authenticate, ctx.require("contributor")] };

  /**
   * Write one staging file while holding the submission's row lock, so an upload can never land after the
   * submission was submitted. Any (re-)upload resets the media's `complete` flag until `complete` is called again.
   */
  async function upload(
    req: FastifyRequest,
    id: string,
    sha: string,
    write: (m: MediaItem) => { check: () => void; run: () => Promise<void> },
  ): Promise<void> {
    const pk = caller(req);
    await withTx(ctx.pool, async (c) => {
      const row = await loadSubmission(c, id, true);
      if (row.contributor !== pk) throw notFound("submission");
      if (!canTransition("upload", row.state)) throw new TransitionError("upload", row.state);
      const m = findMedia(row, sha);
      const w = write(m);
      w.check();
      await w.run();
      if (m.complete)
        await transition(c, "upload", { id, contributor: pk, sets: { media: withComplete(row.media, sha, false) } });
    });
  }

  app.put<{ Params: MediaParams }>("/submissions/:id/media/:sha256/header", writer, async (req) => {
    const id = parseId(req.params.id);
    const sha = parseSha(req.params.sha256);
    const bytes = rawBytes(req);
    await upload(req, id, sha, () => ({
      check: () => {
        if (bytes.length !== HEADER_BYTES)
          throw badRequest("invalid_header", `the secretstream header must be exactly ${HEADER_BYTES} bytes`);
      },
      run: () => ctx.staging.writeHeader(id, sha, bytes),
    }));
    return { ok: true };
  });

  app.put<{ Params: ChunkParams }>("/submissions/:id/media/:sha256/chunks/:n", writer, async (req) => {
    const id = parseId(req.params.id);
    const sha = parseSha(req.params.sha256);
    const n = parseChunkIndex(req.params.n);
    const bytes = rawBytes(req);
    await upload(req, id, sha, (m) => ({
      check: () => {
        if (n >= m.chunks) throw badRequest("chunk_out_of_range", `chunk index must be below ${m.chunks}`);
        const want = expectedChunkBytes(m.size, n);
        if (bytes.length !== want)
          throw badRequest("invalid_chunk_size", `chunk ${n} must be exactly ${want} bytes, got ${bytes.length}`);
      },
      run: () => ctx.staging.writeChunk(id, sha, n, bytes),
    }));
    return { ok: true, n };
  });

  /** Chunks present with the exact expected size, and whether the header is there. */
  async function received(id: string, m: MediaItem) {
    const inv = await ctx.staging.inventory(id, m.sha256);
    const chunks = [...inv.chunks]
      .filter(([n, size]) => n < m.chunks && size === expectedChunkBytes(m.size, n))
      .map(([n]) => n)
      .sort((a, b) => a - b);
    return { header: inv.header === HEADER_BYTES, chunks };
  }

  app.get<{ Params: MediaParams }>(
    "/submissions/:id/media/:sha256/status",
    { preHandler: [ctx.authenticate] },
    async (req) => {
      const id = parseId(req.params.id);
      const sha = parseSha(req.params.sha256);
      const row = await loadSubmission(ctx.pool, id);
      await readAccess(ctx, req, row);
      const m = findMedia(row, sha);
      const r = await received(id, m);
      return { received: r.chunks, header: r.header, chunks: m.chunks, complete: m.complete };
    },
  );

  app.post<{ Params: MediaParams }>("/submissions/:id/media/:sha256/complete", writer, async (req) => {
    const pk = caller(req);
    const id = parseId(req.params.id);
    const sha = parseSha(req.params.sha256);
    return withTx(ctx.pool, async (c) => {
      const row = await loadSubmission(c, id, true);
      if (row.contributor !== pk) throw notFound("submission");
      if (!canTransition("upload", row.state)) throw new TransitionError("upload", row.state);
      const m = findMedia(row, sha);
      const r = await received(id, m);
      const have = new Set(r.chunks);
      const missing: number[] = [];
      for (let n = 0; n < m.chunks && missing.length < 50; n++) if (!have.has(n)) missing.push(n);
      if (!r.header || missing.length)
        throw conflict(
          "media_incomplete",
          `${r.header ? "" : "header missing; "}${missing.length ? `missing chunks: ${missing.join(", ")}` : ""}`.replace(
            /; $/,
            "",
          ),
        );
      if (!m.complete)
        await transition(c, "upload", { id, contributor: pk, sets: { media: withComplete(row.media, sha, true) } });
      return { sha256: sha, complete: true };
    });
  });

  async function download(req: FastifyRequest<{ Params: MediaParams }>, name: "header" | number) {
    const id = parseId(req.params.id);
    const sha = parseSha(req.params.sha256);
    const row = await loadSubmission(ctx.pool, id);
    await readAccess(ctx, req, row);
    const m = findMedia(row, sha);
    if (typeof name === "number" && name >= m.chunks) throw notFound("chunk");
    const bytes = await ctx.staging.read(id, sha, name);
    if (!bytes) throw notFound(name === "header" ? "header" : "chunk");
    return bytes;
  }

  app.get<{ Params: MediaParams }>(
    "/submissions/:id/media/:sha256/header",
    { preHandler: [ctx.authenticate] },
    async (req, reply) => reply.type("application/octet-stream").send(await download(req, "header")),
  );

  app.get<{ Params: ChunkParams }>(
    "/submissions/:id/media/:sha256/chunks/:n",
    { preHandler: [ctx.authenticate] },
    async (req, reply) =>
      reply.type("application/octet-stream").send(await download(req, parseChunkIndex(req.params.n))),
  );
}
