import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { caller, type Ctx } from "../context.js";
import { isUniqueViolation, withTx, type Client } from "../db.js";
import { HttpError, conflict } from "../errors.js";
import { consumeRate } from "../rateLimit.js";
import { NOW, TransitionError, canTransition, recordEvent, transition, type MediaItem } from "../stateMachine.js";
import {
  checkWrappedKeys,
  loadSubmission,
  parseId,
  readAccess,
  submissionView,
  validateMedia,
  wrappedKeyFor,
} from "../submissions.js";
import { parse, submissionBody } from "../validation.js";

type Params = { id: string };

/** A story id belongs to the contributor who first submitted it; later versions must come from the same key. */
async function checkStoryOwner(c: Client, storyId: string, contributor: string, exceptId?: string): Promise<void> {
  const r = await c.query("SELECT 1 FROM submissions WHERE story_id = $1 AND contributor <> $2 AND id <> $3 LIMIT 1", [
    storyId,
    contributor,
    exceptId ?? "00000000-0000-0000-0000-000000000000",
  ]);
  if (r.rowCount) throw new HttpError(403, "story_not_yours", "this story id belongs to another contributor");
}

export function submissionRoutes(app: FastifyInstance, ctx: Ctx): void {
  const schema = submissionBody(ctx.config.maxJsonBytes, ctx.maxMedia);

  app.post("/submissions", { preHandler: [ctx.authenticate, ctx.require("contributor")] }, async (req, reply) => {
    const pk = caller(req);
    const b = parse(schema, req.body);
    validateMedia(ctx, b.media);
    checkWrappedKeys(ctx, b.wrappedKeys);
    const id = randomUUID();
    const media: MediaItem[] = b.media.map((m) => ({ ...m, kind: m.kind, complete: false }));
    try {
      await withTx(ctx.pool, async (c) => {
        if (!(await consumeRate(c, pk, "submission", ctx.config.submissionsPerHour)))
          throw new HttpError(429, "rate_limited", "too many new submissions; try again later");
        await checkStoryOwner(c, b.storyId, pk);
        await c.query(
          `INSERT INTO submissions (id, story_id, version, supersedes, contributor, body_ciphertext, wrapped_keys, media)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
          [
            id,
            b.storyId,
            b.version,
            b.supersedes,
            pk,
            b.bodyCiphertext,
            JSON.stringify(b.wrappedKeys),
            JSON.stringify(media),
          ],
        );
        await recordEvent(c, { submissionId: id, actor: pk, event: "created", to: "draft" });
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw conflict("version_exists", "this story already has a submission for this version");
      throw e;
    }
    return reply.code(201).send({ id });
  });

  app.put<{ Params: Params }>(
    "/submissions/:id",
    { preHandler: [ctx.authenticate, ctx.require("contributor")] },
    async (req) => {
      const pk = caller(req);
      const id = parseId(req.params.id);
      const b = parse(schema, req.body);
      validateMedia(ctx, b.media);
      checkWrappedKeys(ctx, b.wrappedKeys);
      let removed: string[] = [];
      let row;
      try {
        row = await withTx(ctx.pool, async (c) => {
          const cur = await loadSubmission(c, id, true);
          if (cur.contributor !== pk) throw new HttpError(404, "not_found", "submission not found");
          if (!canTransition("edit", cur.state)) throw new TransitionError("edit", cur.state);
          if (cur.story_id !== b.storyId) await checkStoryOwner(c, b.storyId, pk, id);
          const old = new Map(cur.media.map((m) => [m.sha256, m]));
          const media: MediaItem[] = b.media.map((m) => {
            const prev = old.get(m.sha256);
            const same = prev && prev.size === m.size && prev.chunks === m.chunks && prev.kind === m.kind;
            return { ...m, complete: same ? prev.complete : false };
          });
          const keep = new Set(media.filter((m) => old.get(m.sha256)?.size === m.size).map((m) => m.sha256));
          removed = cur.media.filter((m) => !keep.has(m.sha256)).map((m) => m.sha256);
          const updated = await transition(c, "edit", {
            id,
            contributor: pk,
            sets: {
              story_id: b.storyId,
              version: b.version,
              supersedes: b.supersedes,
              body_ciphertext: b.bodyCiphertext,
              wrapped_keys: b.wrappedKeys,
              media,
            },
          });
          // After a change request the reviewed version is kept (encrypted) so the history stays complete.
          await recordEvent(c, {
            submissionId: id,
            actor: pk,
            event: "edited",
            from: cur.state,
            to: updated.state,
            detail:
              cur.state === "changes_requested"
                ? { previous: { bodyCiphertext: cur.body_ciphertext, wrappedKeys: cur.wrapped_keys, media: cur.media } }
                : {},
          });
          return updated;
        });
      } catch (e) {
        if (isUniqueViolation(e))
          throw conflict("version_exists", "this story already has a submission for this version");
        throw e;
      }
      for (const sha of removed) await ctx.staging.removeMedia(id, sha);
      return { id, state: row.state };
    },
  );

  app.post<{ Params: Params }>(
    "/submissions/:id/submit",
    { preHandler: [ctx.authenticate, ctx.require("contributor")] },
    async (req) => {
      const pk = caller(req);
      const id = parseId(req.params.id);
      const row = await withTx(ctx.pool, async (c) => {
        const cur = await loadSubmission(c, id, true);
        if (cur.contributor !== pk) throw new HttpError(404, "not_found", "submission not found");
        if (!canTransition("submit", cur.state)) throw new TransitionError("submit", cur.state);
        const incomplete = cur.media.filter((m) => !m.complete).map((m) => m.sha256);
        if (incomplete.length)
          throw conflict("media_incomplete", `media not uploaded completely: ${incomplete.join(", ")}`);
        const updated = await transition(c, "submit", {
          id,
          contributor: pk,
          sets: { submitted_at: NOW, claim_by: null, claim_until: null },
        });
        await recordEvent(c, { submissionId: id, actor: pk, event: "submitted", from: cur.state, to: updated.state });
        return updated;
      });
      return { id, state: row.state };
    },
  );

  app.get("/me/submissions", { preHandler: [ctx.authenticate, ctx.require("known-contributor")] }, async (req) => {
    const r = await ctx.pool.query(
      `SELECT id, story_id, version, state, feedback, created_at, updated_at, manifest_cid, published_at
       FROM submissions WHERE contributor = $1 ORDER BY created_at DESC, id`,
      [caller(req)],
    );
    return r.rows.map((s) => ({
      id: s.id,
      storyId: s.story_id,
      version: s.version,
      state: s.state,
      feedback: s.feedback ?? [],
      createdAt: s.created_at.toISOString(),
      updatedAt: s.updated_at.toISOString(),
      manifestCid: s.manifest_cid,
      publishedAt: s.published_at?.toISOString() ?? null,
    }));
  });

  app.get<{ Params: Params; Querystring: { x25519?: string } }>(
    "/submissions/:id",
    { preHandler: [ctx.authenticate] },
    async (req) => {
      const id = parseId(req.params.id);
      const row = await loadSubmission(ctx.pool, id);
      const access = await readAccess(ctx, req, row);
      const wrappedKey = wrappedKeyFor(ctx, req, access, row.wrapped_keys, req.query.x25519);
      const x = req.query.x25519;
      const hist = await ctx.pool.query(
        "SELECT at, actor, event, from_state, to_state, detail FROM submission_events WHERE submission_id = $1 ORDER BY id",
        [id],
      );
      const history = hist.rows.map((h) => {
        const prev = h.detail?.previous as
          { bodyCiphertext: string; wrappedKeys: Record<string, string>; media: MediaItem[] } | undefined;
        return {
          at: h.at.toISOString(),
          actor: h.actor,
          event: h.event,
          fromState: h.from_state,
          toState: h.to_state,
          ...(h.detail?.recipients ? { recipients: h.detail.recipients } : {}),
          ...(prev
            ? {
                previous: {
                  bodyCiphertext: prev.bodyCiphertext ?? null,
                  media: prev.media,
                  wrappedKey: x !== undefined && prev.wrappedKeys ? (prev.wrappedKeys[x] ?? null) : null,
                },
              }
            : {}),
        };
      });
      return { ...submissionView(ctx, row), wrappedKey, history };
    },
  );
}
