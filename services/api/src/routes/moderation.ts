/** The moderation queue: claim, approve, reject, request changes, re-wrap keys, unlist, hide/mute audit. */
import { hexToNpub, verifyHash, type Event } from "@azaadawaaz/core";
import { approvalMessageHash } from "@azaadawaaz/schema";
import type { FastifyInstance } from "fastify";
import { raiseAlert } from "../alerts.js";
import { storeAudit, verifyAuditEvent, type AuditAction } from "../audit.js";
import { getContributor, isRevoked } from "../auth.js";
import { caller, type Ctx } from "../context.js";
import { withTx } from "../db.js";
import { HttpError, badRequest, conflict } from "../errors.js";
import { consumeRate } from "../rateLimit.js";
import {
  NOW,
  Sql,
  TransitionError,
  appendFeedback,
  canTransition,
  recordEvent,
  transition,
  type FeedbackEntry,
  type SubmissionRow,
} from "../stateMachine.js";
import { activeClaim, loadSubmission, parseId } from "../submissions.js";
import {
  approveBody,
  auditBody,
  claimBody,
  feedbackBody,
  keysBody,
  parse,
  unlistBody,
} from "../validation.js";

type Params = { id: string };

/** How far an approval's `approvedAt` may be from the server clock. */
export const APPROVAL_WINDOW_SEC = 600;

export function moderationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const moderator = { preHandler: [ctx.authenticate, ctx.require("moderator")] };
  const staff = { preHandler: [ctx.authenticate, ctx.require("owner", "moderator")] };

  app.get("/queue", moderator, async (req) => {
    const myX = ctx.lists.x25519For(caller(req));
    const r = await ctx.pool.query<SubmissionRow>(
      `SELECT * FROM submissions WHERE state IN ('submitted', 'in_review')
       ORDER BY submitted_at ASC NULLS LAST, created_at ASC, id`,
    );
    return r.rows.map((s) => {
      const claim = activeClaim(ctx, s);
      return {
        id: s.id,
        storyId: s.story_id,
        version: s.version,
        supersedes: s.supersedes,
        contributor: s.contributor,
        state: s.state,
        submittedAt: s.submitted_at?.toISOString() ?? null,
        claimBy: claim?.by ?? null,
        claimUntil: claim?.until ?? null,
        media: { count: s.media.length, totalBytes: s.media.reduce((n, m) => n + m.size, 0) },
        wrappedForMe: myX !== undefined && myX in s.wrapped_keys,
      };
    });
  });

  app.post<{ Params: Params }>("/submissions/:id/claim", moderator, async (req) => {
    const pk = caller(req);
    const id = parseId(req.params.id);
    const body = parse(claimBody, req.body);
    const audit = body?.auditEvent
      ? verifyAuditEvent(body.auditEvent, { actor: pk, action: "claim", submissionId: id }, ctx.nowSec())
      : undefined;
    const row = await withTx(ctx.pool, async (c) => {
      const cur = await loadSubmission(c, id, true);
      if (!canTransition("claim", cur.state)) throw new TransitionError("claim", cur.state);
      const claim = activeClaim(ctx, cur);
      if (claim && claim.by !== pk)
        throw conflict("claimed", `claimed by another moderator until ${claim.until}; the claim is advisory`);
      const updated = await transition(c, "claim", {
        id,
        sets: { claim_by: pk, claim_until: new Sql(`now() + interval '${ctx.config.claimMinutes} minutes'`) },
      });
      if (audit) await storeAudit(c, audit, { action: "claim", submissionId: id });
      await recordEvent(c, { submissionId: id, actor: pk, event: "claimed", from: cur.state, to: updated.state });
      return updated;
    });
    if (audit) ctx.forwarder.forward(audit);
    return { id, state: row.state, claimBy: pk, claimUntil: row.claim_until!.toISOString() };
  });

  app.post<{ Params: Params }>("/submissions/:id/approve", moderator, async (req) => {
    const pk = caller(req);
    const id = parseId(req.params.id);
    const b = parse(approveBody, req.body);
    const pre = await loadSubmission(ctx.pool, id);

    // The approval must be the caller's own valid signature over approvalMessageHash(bodySha256, approvedAt).
    if (b.approval.moderator !== hexToNpub(pk))
      throw badRequest("invalid_approval", "approval.moderator must be the caller's key");
    const approvedAtMs = Date.parse(b.approval.approvedAt);
    if (!Number.isFinite(approvedAtMs) || Math.abs(approvedAtMs - ctx.now()) > APPROVAL_WINDOW_SEC * 1000)
      throw badRequest("invalid_approval", "approval.approvedAt is too far from the server time");
    const msg = approvalMessageHash(b.approvalBodySha256, b.approval.approvedAt);
    if (!verifyHash(b.approval.signature, msg, pk))
      throw badRequest("invalid_approval", "approval signature does not verify");
    const audit = verifyAuditEvent(
      b.auditEvent,
      { actor: pk, action: "approve", submissionId: id, storyId: pre.story_id },
      ctx.nowSec(),
    );

    const row = await withTx(ctx.pool, async (c) => {
      const cur = await loadSubmission(c, id, true);
      if (!canTransition("approve", cur.state)) throw new TransitionError("approve", cur.state);
      const contributor = await getContributor(ctx.pool, cur.contributor);
      if (!contributor || isRevoked(ctx.lists, contributor))
        throw conflict("contributor_revoked", "the contributor has been revoked");
      if (cur.media.some((m) => !m.complete)) throw conflict("media_incomplete", "media upload is incomplete");
      const updated = await transition(c, "approve", {
        id,
        sets: {
          approval: b.approval,
          approval_body_sha256: b.approvalBodySha256,
          publisher_wrapped_key: b.publisherWrappedKey,
          decided_at: NOW,
          claim_by: null,
          claim_until: null,
        },
      });
      await c.query("INSERT INTO publish_jobs (submission_id) VALUES ($1)", [id]);
      await storeAudit(c, audit, { action: "approve", submissionId: id });
      await recordEvent(c, { submissionId: id, actor: pk, event: "approved", from: cur.state, to: updated.state });
      return updated;
    });
    ctx.forwarder.forward(audit);
    return { id, state: row.state };
  });

  for (const [path, action, kind] of [
    ["reject", "reject", "reject"],
    ["request-changes", "request_changes", "changes"],
  ] as const) {
    app.post<{ Params: Params }>(`/submissions/:id/${path}`, moderator, async (req) => {
      const pk = caller(req);
      const id = parseId(req.params.id);
      const b = parse(feedbackBody, req.body);
      const audit = verifyAuditEvent(b.auditEvent, { actor: pk, action, submissionId: id }, ctx.nowSec());
      const entry: FeedbackEntry = { at: new Date(ctx.now()).toISOString(), moderator: pk, kind, nip44: b.feedback };
      const row = await withTx(ctx.pool, async (c) => {
        const cur = await loadSubmission(c, id, true);
        if (!canTransition(action, cur.state)) throw new TransitionError(action, cur.state);
        const updated = await transition(c, action, {
          id,
          sets: {
            feedback: appendFeedback(entry),
            claim_by: null,
            claim_until: null,
            ...(action === "reject" ? { decided_at: NOW } : {}),
          },
        });
        await storeAudit(c, audit, { action, submissionId: id });
        await recordEvent(c, {
          submissionId: id,
          actor: pk,
          event: action === "reject" ? "rejected" : "changes_requested",
          from: cur.state,
          to: updated.state,
        });
        return updated;
      });
      ctx.forwarder.forward(audit);
      return { id, state: row.state };
    });
  }

  app.post<{ Params: Params }>("/submissions/:id/keys", staff, async (req) => {
    const pk = caller(req);
    const id = parseId(req.params.id);
    const { wrappedKeys } = parse(keysBody, req.body);
    const allowed = new Set(ctx.lists.requiredRecipients());
    const unknown = Object.keys(wrappedKeys).filter((k) => !allowed.has(k));
    if (unknown.length)
      throw badRequest("unknown_recipient", `not a current owner or moderator key: ${unknown.join(", ")}`);
    return withTx(ctx.pool, async (c) => {
      const cur = await loadSubmission(c, id, true);
      if (!canTransition("rewrap", cur.state)) throw new TransitionError("rewrap", cur.state);
      // Only missing wraps are added: an existing recipient's wrap is never replaced.
      const added = Object.keys(wrappedKeys).filter((k) => !(k in cur.wrapped_keys));
      if (added.length) {
        const merged = { ...cur.wrapped_keys };
        for (const k of added) merged[k] = wrappedKeys[k]!;
        await transition(c, "rewrap", { id, sets: { wrapped_keys: merged } });
        await recordEvent(c, { submissionId: id, actor: pk, event: "keys_added", detail: { recipients: added } });
      }
      return { id, added };
    });
  });

  app.get("/rewrap-needed", staff, async (req) => {
    const required = ctx.lists.requiredRecipients();
    const myX = ctx.lists.x25519For(caller(req));
    const r = await ctx.pool.query<SubmissionRow>(
      `SELECT * FROM submissions WHERE state IN ('draft', 'submitted', 'in_review', 'changes_requested')
       ORDER BY created_at, id`,
    );
    return r.rows
      .map((s) => ({ s, missing: required.filter((k) => !(k in s.wrapped_keys)) }))
      .filter((x) => x.missing.length > 0)
      .map(({ s, missing }) => ({
        id: s.id,
        storyId: s.story_id,
        version: s.version,
        state: s.state,
        missing,
        wrappedKey: myX !== undefined ? (s.wrapped_keys[myX] ?? null) : null,
      }));
  });

  app.post("/moderation/unlist", staff, async (req, reply) => {
    const pk = caller(req);
    const { storyId, auditEvent } = parse(unlistBody, req.body);
    const audit = verifyAuditEvent(auditEvent, { actor: pk, action: "unlist", storyId }, ctx.nowSec());
    const isOwner = ctx.lists.isOwner(pk);
    const result = await withTx(ctx.pool, async (c) => {
      if (!isOwner && !(await consumeRate(c, pk, "unlist", ctx.config.unlistPerHour))) {
        await raiseAlert(c, "unlist_rate_limited", { moderator: pk, storyId, auditEventId: audit.id });
        return { limited: true as const };
      }
      const rows = await c.query<{ id: string }>(
        "SELECT id FROM submissions WHERE story_id = $1 AND state = 'published' ORDER BY version FOR UPDATE",
        [storyId],
      );
      const latest = await c.query<{ id: string }>(
        "SELECT id FROM submissions WHERE story_id = $1 ORDER BY version DESC LIMIT 1",
        [storyId],
      );
      await storeAudit(c, audit, { action: "unlist", submissionId: latest.rows[0]?.id ?? null });
      for (const { id } of rows.rows) {
        await transition(c, "unlist", { id });
        await recordEvent(c, { submissionId: id, actor: pk, event: "unlisted", from: "published", to: "unlisted" });
      }
      await raiseAlert(c, "unlist", { moderator: pk, storyId, auditEventId: audit.id, unlisted: rows.rowCount });
      return { limited: false as const, unlisted: rows.rowCount ?? 0 };
    });
    if (result.limited)
      throw new HttpError(429, "rate_limited", `at most ${ctx.config.unlistPerHour} unlistings per hour; the owner was alerted`);
    ctx.forwarder.forward(audit);
    return reply.send({ storyId, unlisted: result.unlisted });
  });

  app.post("/moderation/audit", staff, async (req) => {
    const pk = caller(req);
    const { auditEvent } = parse(auditBody, req.body);
    const action = (auditEvent as unknown as Event).tags?.find?.((t) => Array.isArray(t) && t[0] === "action")?.[1] as
      | AuditAction
      | undefined;
    if (action !== "hide" && action !== "mute")
      throw badRequest("invalid_audit", 'this endpoint takes "hide" and "mute" audit events');
    const e = verifyAuditEvent(
      auditEvent,
      { actor: pk, action, target: { tag: action === "hide" ? "e" : "p" } },
      ctx.nowSec(),
    );
    await storeAudit(ctx.pool, e, { action });
    ctx.forwarder.forward(e);
    return { id: e.id, action };
  });
}
