import { generateKeyPair } from "@azaadawaaz/core";
import { uuidv7 } from "@azaadawaaz/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvePayload,
  auditEvent,
  inReviewSubmission,
  setup,
  submittedSubmission,
  type Actor,
  type TestEnv,
} from "./helpers.js";

describe("moderation", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ unlistPerHour: 3 });
  });
  afterAll(async () => {
    await env?.close();
  });

  const unlist = (who: Actor, storyId: string, skew = 0) =>
    env.client(who).post("/moderation/unlist", {
      storyId,
      auditEvent: auditEvent(who.kp, "unlist", { storyId }, Math.floor(Date.now() / 1000) - skew),
    });

  it("unlistings are rate-limited per moderator and every call alerts the owner", async () => {
    await env.client(env.owner).post("/owner/alerts/seen", {});
    for (let i = 0; i < 3; i++) {
      const r = await unlist(env.mod1, uuidv7());
      expect(r.status).toBe(200);
    }
    const limited = await unlist(env.mod1, uuidv7());
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    // another moderator has their own budget; the owner is not limited
    expect((await unlist(env.mod2, uuidv7())).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await unlist(env.owner, uuidv7(), i)).status).toBe(200);

    const alerts = await env.client(env.owner).get("/owner/alerts");
    const kinds = alerts.body.map((a: { kind: string }) => a.kind);
    expect(kinds.filter((k: string) => k === "unlist")).toHaveLength(3 + 1 + 4);
    expect(kinds.filter((k: string) => k === "unlist_rate_limited")).toHaveLength(1);
    const rl = alerts.body.find((a: { kind: string }) => a.kind === "unlist_rate_limited");
    expect(rl.detail.moderator).toBe(env.mod1.kp.pubkey);
    // the rate-limited unlisting was neither stored nor forwarded
    const stored = await env.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'unlist' AND actor = $1",
      [env.mod1.kp.pubkey],
    );
    expect(stored.rows[0].n).toBe(3);
    // mark seen
    const seen = await env.client(env.owner).post("/owner/alerts/seen", { ids: [rl.id] });
    expect(seen.body.seen).toBe(1);
    expect((await env.client(env.owner).get("/owner/alerts")).body).toHaveLength(alerts.body.length - 1);
    expect((await env.client(env.owner).post("/owner/alerts/seen")).body.seen).toBe(alerts.body.length - 1);
    expect((await env.client(env.owner).get("/owner/alerts")).body).toEqual([]);
  });

  it("unlist requires a matching story tag", async () => {
    const storyId = uuidv7();
    const r = await env.client(env.mod2).post("/moderation/unlist", {
      storyId,
      auditEvent: auditEvent(env.mod2.kp, "unlist", { storyId: uuidv7() }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_audit");
  });

  it("hide and mute audit events are stored and forwarded", async () => {
    const commentId = "c".repeat(64);
    const muted = generateKeyPair().pubkey;
    const hide = await env
      .client(env.mod2)
      .post("/moderation/audit", { auditEvent: auditEvent(env.mod2.kp, "hide", { e: commentId }) });
    expect(hide.status).toBe(200);
    expect(hide.body.action).toBe("hide");
    const mute = await env
      .client(env.owner)
      .post("/moderation/audit", { auditEvent: auditEvent(env.owner.kp, "mute", { p: muted }) });
    expect(mute.status).toBe(200);
    expect(env.forwarded.events.map((e) => e.id)).toEqual(expect.arrayContaining([hide.body.id, mute.body.id]));
    const rows = await env.pool.query("SELECT action, submission_id FROM audit_events WHERE id = ANY($1)", [
      [hide.body.id, mute.body.id],
    ]);
    expect(rows.rows.map((r) => r.action).sort()).toEqual(["hide", "mute"]);
    // other actions and missing targets are refused
    expect(
      (await env.client(env.mod2).post("/moderation/audit", { auditEvent: auditEvent(env.mod2.kp, "approve") })).status,
    ).toBe(400);
    expect(
      (await env.client(env.mod2).post("/moderation/audit", { auditEvent: auditEvent(env.mod2.kp, "hide") })).status,
    ).toBe(400);
    // contributors can't
    const s = await submittedSubmission(env);
    expect(
      (await s.c.post("/moderation/audit", { auditEvent: auditEvent(s.contributor, "hide", { e: commentId }) })).status,
    ).toBe(403);
  });

  it("a claim may carry an audit event; replaying it is refused", async () => {
    const s = await submittedSubmission(env);
    const e = auditEvent(env.mod1.kp, "claim", { submissionId: s.id });
    const r = await env.client(env.mod1).post(`/submissions/${s.id}/claim`, { auditEvent: e });
    expect(r.status).toBe(200);
    const again = await env.client(env.mod1).post(`/submissions/${s.id}/claim`, { auditEvent: e });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("audit_replayed");
  });

  it("the queue lists submitted and in-review work oldest first; a removed moderator's claim is released", async () => {
    const a = await submittedSubmission(env);
    const b = await inReviewSubmission(env, env.mod2);
    const q = await env.client(env.mod1).get("/queue");
    const ids = q.body.map((x: { id: string }) => x.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    const item = q.body.find((x: { id: string }) => x.id === b.id);
    expect(item).toMatchObject({ state: "in_review", claimBy: env.mod2.kp.pubkey, wrappedForMe: true });
    expect(item.media.count).toBe(1);
    env.setModerators([{ actor: env.mod1 }]);
    try {
      const q2 = await env.client(env.mod1).get("/queue");
      expect(q2.body.find((x: { id: string }) => x.id === b.id).claimBy).toBeNull();
      expect((await env.client(env.mod1).post(`/submissions/${b.id}/claim`)).status).toBe(200);
    } finally {
      env.setModerators([{ actor: env.mod1 }, { actor: env.mod2 }]);
    }
  });

  it("publish jobs are visible to staff and the owner can retry them", async () => {
    const s = await inReviewSubmission(env);
    const { payload } = await approvePayload(env, env.mod1, s);
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/approve`, payload)).status).toBe(200);
    await env.pool.query(
      `UPDATE publish_jobs SET state = 'failed', attempts = 2, next_attempt_at = now() + interval '1 hour',
       steps = '{"decrypt":{"done":true,"attempts":1},"ipfs":{"done":false,"error":"node down","attempts":2}}' WHERE submission_id = $1`,
      [s.id],
    );
    const jobs = await env.client(env.mod2).get("/jobs");
    const job = jobs.body.find((j: { submissionId: string }) => j.submissionId === s.id);
    expect(job).toMatchObject({ state: "failed", attempts: 2, storyId: s.draft.storyId, submissionState: "approved" });
    expect(job.steps.ipfs.error).toBe("node down");
    const retry = await env.client(env.owner).post(`/jobs/${s.id}/retry`);
    expect(retry.status).toBe(200);
    expect(Date.parse(retry.body.nextAttemptAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await env.client(env.mod1).post(`/jobs/${s.id}/retry`)).status).toBe(403);
    await env.pool.query("UPDATE publish_jobs SET state = 'done' WHERE submission_id = $1", [s.id]);
    expect((await env.client(env.owner).post(`/jobs/${s.id}/retry`)).body.error).toBe("job_done");
    expect((await env.client(env.owner).post(`/jobs/${"0b9c3a2e-1111-4222-8333-444455556666"}/retry`)).status).toBe(
      404,
    );
    expect((await env.client(env.owner).post(`/jobs/nope/retry`)).status).toBe(400);
  });
});
