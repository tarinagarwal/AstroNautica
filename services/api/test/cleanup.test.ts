import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup.js";
import { StagingStore } from "../src/staging.js";
import { transition } from "../src/stateMachine.js";
import {
  approvePayload,
  auditEvent,
  feedbackFor,
  inReviewSubmission,
  setup,
  type Sub,
  type TestEnv,
} from "./helpers.js";

describe("retention cleanup", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  const reject = async (s: Sub) => {
    const r = await env.client(env.mod1).post(`/submissions/${s.id}/reject`, {
      feedback: feedbackFor(env.mod1.kp, s.contributor.pubkey, "no"),
      auditEvent: auditEvent(env.mod1.kp, "reject", { submissionId: s.id }),
    });
    expect(r.status).toBe(200);
  };
  const dir = (id: string) => join(env.config.stagingDir, id);
  const row = async (id: string) => (await env.pool.query("SELECT * FROM submissions WHERE id = $1", [id])).rows[0];

  it("deletes rejected staging data after the retention period and published staging data right away", async () => {
    const oldRejected = await inReviewSubmission(env);
    await reject(oldRejected);
    await env.pool.query("UPDATE submissions SET decided_at = now() - interval '31 days' WHERE id = $1", [
      oldRejected.id,
    ]);
    const recentRejected = await inReviewSubmission(env);
    await reject(recentRejected);

    const published = await inReviewSubmission(env);
    const { payload } = await approvePayload(env, env.mod1, published);
    expect((await env.client(env.mod1).post(`/submissions/${published.id}/approve`, payload)).status).toBe(200);
    const approvedOnly = await inReviewSubmission(env);
    const p2 = await approvePayload(env, env.mod1, approvedOnly);
    expect((await env.client(env.mod1).post(`/submissions/${approvedOnly.id}/approve`, p2.payload)).status).toBe(200);
    await transition(env.pool, "start_publishing", { id: published.id });
    await transition(env.pool, "mark_published", { id: published.id });

    await env.pool.query(
      "INSERT INTO rate_events (pubkey, action, at) VALUES ('x', 'unlist', now() - interval '2 days')",
    );
    for (const s of [oldRejected, recentRejected, published, approvedOnly]) expect(existsSync(dir(s.id))).toBe(true);

    const staging = new StagingStore(env.config.stagingDir);
    const r = await runCleanup({ pool: env.pool, staging, rejectedRetentionDays: 30 });
    expect(r).toEqual({ rejectedPurged: 1, publishedPurged: 1, rateEventsPruned: 1 });

    expect(existsSync(dir(oldRejected.id))).toBe(false);
    expect(existsSync(dir(published.id))).toBe(false);
    expect(existsSync(dir(recentRejected.id))).toBe(true);
    expect(existsSync(dir(approvedOnly.id))).toBe(true); // still needed by the publisher

    const purged = await row(oldRejected.id);
    expect(purged.staging_purged_at).not.toBeNull();
    expect(purged.body_ciphertext).toBe("");
    expect(purged.wrapped_keys).toEqual({});
    expect(purged.state).toBe("rejected");
    expect(purged.feedback).toHaveLength(1); // the decision and its history stay
    const pub = await row(published.id);
    expect(pub.publisher_wrapped_key).toBeNull();
    expect((await row(approvedOnly.id)).publisher_wrapped_key).not.toBeNull();

    // idempotent
    expect(await runCleanup({ pool: env.pool, staging, rejectedRetentionDays: 30 })).toEqual({
      rejectedPurged: 0,
      publishedPurged: 0,
      rateEventsPruned: 0,
    });
    // the owner/moderators can still see the record, without data
    const view = await env.client(env.mod2).get(`/submissions/${oldRejected.id}?x25519=${env.mod2.x.publicKey}`);
    expect(view.body.wrappedKey).toBeNull();
    expect(view.body.stagingPurgedAt).not.toBeNull();
    expect(
      (
        await env
          .client(env.mod2)
          .get(`/submissions/${oldRejected.id}/media/${oldRejected.draft.media[0]!.sha256}/header`)
      ).status,
    ).toBe(404);
  });

  it("a retention of 0 days purges rejected submissions immediately", async () => {
    const s = await inReviewSubmission(env);
    await reject(s);
    await env.pool.query("UPDATE submissions SET decided_at = now() - interval '1 second' WHERE id = $1", [s.id]);
    const r = await runCleanup({
      pool: env.pool,
      staging: new StagingStore(env.config.stagingDir),
      rejectedRetentionDays: 0,
    });
    expect(r.rejectedPurged).toBeGreaterThanOrEqual(1);
    expect(existsSync(dir(s.id))).toBe(false);
  });
});
