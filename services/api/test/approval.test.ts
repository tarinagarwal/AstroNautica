import { KIND_AUDIT, signApproval, verifyEventStrict } from "@azaadawaaz/core";
import { approvalBodySha256, sha256Hex } from "@azaadawaaz/schema";
import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvePayload,
  auditEvent,
  feedbackFor,
  inReviewSubmission,
  newActor,
  nowIso,
  setup,
  type TestEnv,
} from "./helpers.js";

describe("approval", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("first approval wins under concurrency: exactly one of two simultaneous approvals succeeds", async () => {
    for (let round = 0; round < 5; round++) {
      const s = await inReviewSubmission(env);
      const [a, b] = await Promise.all([approvePayload(env, env.mod1, s), approvePayload(env, env.mod2, s)]);
      const results = await Promise.all([
        env.client(env.mod1).post(`/submissions/${s.id}/approve`, a.payload),
        env.client(env.mod2).post(`/submissions/${s.id}/approve`, b.payload),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.error).toBe("invalid_state");
      const jobs = await env.pool.query("SELECT count(*)::int AS n FROM publish_jobs WHERE submission_id = $1", [s.id]);
      expect(jobs.rows[0].n).toBe(1);
      const audits = await env.pool.query(
        "SELECT actor FROM audit_events WHERE submission_id = $1 AND action = 'approve'",
        [s.id],
      );
      expect(audits.rows).toHaveLength(1);
      const row = (await env.pool.query("SELECT approval FROM submissions WHERE id = $1", [s.id])).rows[0];
      const winner = results[0]!.status === 200 ? env.mod1 : env.mod2;
      expect(row.approval.moderator).toBe(winner.kp.npub);
      expect(audits.rows[0].actor).toBe(winner.kp.pubkey);
    }
  });

  it("the moderator decrypts exactly what the contributor wrote", async () => {
    const s = await inReviewSubmission(env);
    const { body } = await approvePayload(env, env.mod2, s);
    expect(body).toEqual(s.draft.body);
    expect(approvalBodySha256(body)).toBe(approvalBodySha256(s.draft.body));
  });

  it("rejects a bad approval signature", async () => {
    const s = await inReviewSubmission(env);
    const { payload } = await approvePayload(env, env.mod1, s);
    const tampered = { ...payload, approvalBodySha256: sha256Hex("something else") };
    const r = await env.client(env.mod1).post(`/submissions/${s.id}/approve`, tampered);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_approval");
    expect(r.body.message).toBe("approval signature does not verify");
    const sig = payload.approval.signature;
    const flipped = {
      ...payload,
      approval: { ...payload.approval, signature: (sig[0] === "a" ? "b" : "a") + sig.slice(1) },
    };
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/approve`, flipped)).body.error).toBe(
      "invalid_approval",
    );
    // signed by mod2 but sent by mod1
    const other = await approvePayload(env, env.mod2, s);
    const mixed = { ...payload, approval: other.payload.approval };
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/approve`, mixed)).body.message).toBe(
      "approval.moderator must be the caller's key",
    );
    // a stale approvedAt
    const stale = { ...payload, approval: signApproval(s.draft.body, env.mod1.kp.secretKey, nowIso(-3600)) };
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/approve`, stale)).body.message).toContain(
      "approvedAt",
    );
    expect((await env.pool.query("SELECT state FROM submissions WHERE id = $1", [s.id])).rows[0].state).toBe(
      "in_review",
    );
  });

  it("rejects approvals from non-moderators, removed moderators and contributors", async () => {
    const s = await inReviewSubmission(env);
    const stranger = await newActor();
    const fake = {
      approval: signApproval(s.draft.body, stranger.kp.secretKey),
      approvalBodySha256: approvalBodySha256(s.draft.body),
      publisherWrappedKey: "A".repeat(107),
      auditEvent: auditEvent(stranger.kp, "approve", { submissionId: s.id, storyId: s.draft.storyId }),
    };
    expect((await env.client(stranger).post(`/submissions/${s.id}/approve`, fake)).status).toBe(403);
    const asContributor = {
      ...fake,
      approval: signApproval(s.draft.body, s.contributor.secretKey),
      auditEvent: auditEvent(s.contributor, "approve", { submissionId: s.id, storyId: s.draft.storyId }),
    };
    expect((await s.c.post(`/submissions/${s.id}/approve`, asContributor)).status).toBe(403);
    const { payload } = await approvePayload(env, env.mod2, s);
    env.setModerators([{ actor: env.mod1 }, { actor: env.mod2, until: Math.floor(Date.now() / 1000) - 1 }]);
    try {
      expect((await env.client(env.mod2).post(`/submissions/${s.id}/approve`, payload)).status).toBe(403);
    } finally {
      env.setModerators([{ actor: env.mod1 }, { actor: env.mod2 }]);
    }
    // the owner can approve (everything a moderator can)
    const owner = await approvePayload(env, env.owner, s);
    expect((await env.client(env.owner).post(`/submissions/${s.id}/approve`, owner.payload)).status).toBe(200);
  });

  it("verifies the audit event: signer, kind, action, s tag, story tag, freshness, no replay", async () => {
    const s = await inReviewSubmission(env);
    const { payload } = await approvePayload(env, env.mod1, s);
    const send = (auditEvent: unknown) =>
      env.client(env.mod1).post(`/submissions/${s.id}/approve`, { ...payload, auditEvent });
    const now = Math.floor(Date.now() / 1000);
    const cases: [unknown, string][] = [
      [auditEvent(env.mod2.kp, "approve", { submissionId: s.id, storyId: s.draft.storyId }), "signed by the caller"],
      [auditEvent(env.mod1.kp, "reject", { submissionId: s.id, storyId: s.draft.storyId }), 'action must be "approve"'],
      [auditEvent(env.mod1.kp, "approve", { storyId: s.draft.storyId, extra: [["s", s.id]] }), "sha256(submission id)"],
      [auditEvent(env.mod1.kp, "approve", { submissionId: s.id }), "story tag"],
      [auditEvent(env.mod1.kp, "approve", { submissionId: s.id, storyId: s.draft.storyId }, now - 3600), "server time"],
      [
        finalizeEvent(
          {
            kind: 1,
            created_at: now,
            tags: [
              ["action", "approve"],
              ["s", sha256Hex(s.id)],
              ["story", s.draft.storyId],
            ],
            content: "",
          },
          env.mod1.kp.secretKey,
        ),
        `kind ${KIND_AUDIT}`,
      ],
      [
        finalizeEvent(
          {
            kind: KIND_AUDIT,
            created_at: now,
            tags: [
              ["action", "approve"],
              ["s", sha256Hex(s.id)],
              ["story", s.draft.storyId],
            ],
            content: "x",
          },
          env.mod1.kp.secretKey,
        ),
        "content must be empty",
      ],
      [{ ...(payload.auditEvent as object), created_at: now - 1 }, "signature or id"],
    ];
    for (const [e, msg] of cases) {
      const r = await send(e);
      expect(r.status, msg).toBe(400);
      expect(r.body.error).toBe("invalid_audit");
      expect(r.body.message).toContain(msg);
    }
    const ok = await send(payload.auditEvent);
    expect(ok.status).toBe(200);
    // stored, verifiable, and forwarded to our relays
    const stored = (await env.pool.query("SELECT * FROM audit_events WHERE id = $1", [payload.auditEvent.id])).rows[0];
    expect(stored).toMatchObject({ submission_id: s.id, actor: env.mod1.kp.pubkey, action: "approve" });
    expect(verifyEventStrict(stored.event)).toBe(true);
    expect(env.forwarded.events.map((e) => e.id)).toContain(payload.auditEvent.id);
    // replaying the same audit event elsewhere fails
    const s2 = await inReviewSubmission(env);
    const r2 = await env.client(env.mod1).post(`/submissions/${s2.id}/reject`, {
      feedback: feedbackFor(env.mod1.kp, s2.contributor.pubkey, "no"),
      auditEvent: payload.auditEvent,
    });
    expect(r2.status).toBe(400);
  });

  it("reject and request-changes audit events must not reveal the story id", async () => {
    const s = await inReviewSubmission(env);
    const r = await env.client(env.mod1).post(`/submissions/${s.id}/reject`, {
      feedback: feedbackFor(env.mod1.kp, s.contributor.pubkey, "no"),
      auditEvent: auditEvent(env.mod1.kp, "reject", { submissionId: s.id, storyId: s.draft.storyId }),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("must not reveal the story id");
    const bad = await env.client(env.mod1).post(`/submissions/${s.id}/request-changes`, {
      feedback: "not nip44",
      auditEvent: auditEvent(env.mod1.kp, "request_changes", { submissionId: s.id }),
    });
    expect(bad.body.error).toBe("invalid_body");
  });

  it("an approval of a revoked contributor's submission is refused", async () => {
    const s = await inReviewSubmission(env);
    await env.pool.query("UPDATE contributors SET revoked_at = now() WHERE pubkey = $1", [s.contributor.pubkey]);
    const { payload } = await approvePayload(env, env.mod1, s);
    const r = await env.client(env.mod1).post(`/submissions/${s.id}/approve`, payload);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("contributor_revoked");
  });

  it("the owner reads the full audit log, newest first, paginated", async () => {
    const owner = env.client(env.owner);
    const all = await owner.get("/audit?limit=500");
    expect(all.status).toBe(200);
    const n = all.body.events.length;
    expect(n).toBeGreaterThan(5);
    const times = all.body.events.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const page1 = await owner.get("/audit?limit=3");
    expect(page1.body.events).toHaveLength(3);
    const page2 = await owner.get(`/audit?limit=3&before=${encodeURIComponent(page1.body.next)}`);
    expect(page2.body.events[0].id).toBe(all.body.events[3].id);
    expect((await owner.get("/audit?limit=0")).status).toBe(400);
    expect((await owner.get("/audit?before=yesterday")).status).toBe(400);
    expect((await owner.get("/audit?evil=1")).status).toBe(400);
  });
});
