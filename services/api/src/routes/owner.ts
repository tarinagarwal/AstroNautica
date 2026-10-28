/** Owner views: the audit log, owner alerts, and publish job status / retry. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { alertsSeenBody, parse, uuid } from "../validation.js";

const auditQuery = z
  .object({
    before: z
      .string()
      .refine((s) => Number.isFinite(Date.parse(s)), "must be an ISO time")
      .optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .refine((n) => n >= 1 && n <= 500, "must be 1..500")
      .optional(),
  })
  .strict();

export function ownerRoutes(app: FastifyInstance, ctx: Ctx): void {
  const owner = { preHandler: [ctx.authenticate, ctx.require("owner")] };
  const staff = { preHandler: [ctx.authenticate, ctx.require("owner", "moderator")] };

  app.get("/audit", owner, async (req) => {
    const q = parse(auditQuery, req.query, "query");
    const limit = q.limit ?? 100;
    const r = await ctx.pool.query(
      `SELECT id, submission_id, actor, action, event, created_at FROM audit_events
       WHERE ($1::timestamptz IS NULL OR created_at < $1::timestamptz)
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [q.before ?? null, limit],
    );
    const events = r.rows.map((a) => ({
      id: a.id,
      submissionId: a.submission_id,
      actor: a.actor,
      action: a.action,
      event: a.event,
      createdAt: a.created_at.toISOString(),
    }));
    return { events, next: events.length === limit ? events[events.length - 1]!.createdAt : null };
  });

  app.get("/owner/alerts", owner, async () => {
    const r = await ctx.pool.query(
      "SELECT id, kind, detail, created_at FROM owner_alerts WHERE seen_at IS NULL ORDER BY id DESC LIMIT 1000",
    );
    return r.rows.map((a) => ({ id: Number(a.id), kind: a.kind, detail: a.detail, createdAt: a.created_at.toISOString() }));
  });

  app.post("/owner/alerts/seen", owner, async (req) => {
    const body = parse(alertsSeenBody, req.body);
    const r = body?.ids
      ? await ctx.pool.query("UPDATE owner_alerts SET seen_at = now() WHERE seen_at IS NULL AND id = ANY($1::bigint[])", [
          body.ids,
        ])
      : await ctx.pool.query("UPDATE owner_alerts SET seen_at = now() WHERE seen_at IS NULL");
    return { seen: r.rowCount ?? 0 };
  });

  app.get("/jobs", staff, async () => {
    const r = await ctx.pool.query(
      `SELECT j.*, s.story_id, s.version, s.state AS submission_state
       FROM publish_jobs j JOIN submissions s ON s.id = j.submission_id
       ORDER BY j.updated_at DESC LIMIT 500`,
    );
    return r.rows.map((j) => ({
      submissionId: j.submission_id,
      storyId: j.story_id,
      version: j.version,
      submissionState: j.submission_state,
      state: j.state,
      steps: j.steps,
      attempts: j.attempts,
      nextAttemptAt: j.next_attempt_at.toISOString(),
      lockedUntil: j.locked_until?.toISOString() ?? null,
      createdAt: j.created_at.toISOString(),
      updatedAt: j.updated_at.toISOString(),
    }));
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/retry", owner, async (req) => {
    const id = parse(uuid, req.params.id, "id");
    const r = await ctx.pool.query<{ state: string; next_attempt_at: Date }>(
      `UPDATE publish_jobs SET next_attempt_at = now(), updated_at = now()
       WHERE submission_id = $1 AND state <> 'done' RETURNING state, next_attempt_at`,
      [id],
    );
    if (!r.rows[0]) {
      const exists = await ctx.pool.query("SELECT 1 FROM publish_jobs WHERE submission_id = $1", [id]);
      if (exists.rowCount) throw conflict("job_done", "this job has already finished");
      throw notFound("job");
    }
    return { submissionId: id, state: r.rows[0].state, nextAttemptAt: r.rows[0].next_attempt_at.toISOString() };
  });
}
