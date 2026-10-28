import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup.js";
import { StagingStore } from "../src/staging.js";
import { draftSubmission, makeDraft, newContributor, setup, uploadMedia, type TestEnv } from "./helpers.js";

describe("staging quotas", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ maxSubmissionBytes: 3000, maxContributorStagingBytes: 5000, maxMediaPerSubmission: 3 });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("publishes the limits in GET /config", async () => {
    const r = await env.client(env.mod1).get("/config", { noAuth: true });
    expect(r.body.limits).toMatchObject({
      maxMediaItems: 3,
      maxSubmissionBytes: 3000,
      maxContributorStagingBytes: 5000,
      draftRetentionDays: 30,
    });
  });

  it("caps the total media bytes of one submission, on create and on edit", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    const big = await makeDraft(env, kp, { images: [1500, 1501] });
    const r = await c.post("/submissions", big.request);
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("submission_too_large");
    const ok = await makeDraft(env, kp, { images: [1500, 1500] });
    const created = await c.post("/submissions", ok.request);
    expect(created.status).toBe(201);
    const grow = await makeDraft(env, kp, { images: [1500, 1500, 1], storyId: ok.storyId });
    const put = await c.put(`/submissions/${created.body.id}`, grow.request);
    expect(put.status).toBe(413);
    expect(put.body.error).toBe("submission_too_large");
  });

  it("caps the number of media items per submission", async () => {
    const kp = await newContributor(env);
    const many = await makeDraft(env, kp, { images: [10, 10, 10, 10] });
    const r = await env.client(kp).post("/submissions", many.request);
    expect(r.status).toBe(400);
    const three = await makeDraft(env, kp, { images: [10, 10, 10] });
    expect((await env.client(kp).post("/submissions", three.request)).status).toBe(201);
  });

  it("caps what one contributor stages across submissions in progress", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    const a = await c.post("/submissions", (await makeDraft(env, kp, { images: [2500] })).request);
    const b = await c.post("/submissions", (await makeDraft(env, kp, { images: [2500] })).request);
    expect([a.status, b.status]).toEqual([201, 201]);
    const third = await c.post("/submissions", (await makeDraft(env, kp, { images: [1] })).request);
    expect(third.status).toBe(413);
    expect(third.body.error).toBe("staging_quota_exceeded");
    // Editing a submission counts its new size instead of its old one.
    const aRow = (await env.pool.query("SELECT story_id FROM submissions WHERE id = $1", [a.body.id])).rows[0];
    const shrink = await makeDraft(env, kp, { images: [1000], storyId: aRow.story_id });
    expect((await c.put(`/submissions/${a.body.id}`, shrink.request)).status).toBe(200);
    expect((await c.post("/submissions", (await makeDraft(env, kp, { images: [1500] })).request)).status).toBe(201);
    expect((await c.post("/submissions", (await makeDraft(env, kp, { images: [1] })).request)).status).toBe(413);
    // Another contributor has their own allowance.
    const other = await newContributor(env);
    expect(
      (await env.client(other).post("/submissions", (await makeDraft(env, other, { images: [2500] })).request)).status,
    ).toBe(201);
    // Submissions in a final state no longer count.
    await env.pool.query("UPDATE submissions SET state = 'published' WHERE id = $1", [b.body.id]);
    expect((await c.post("/submissions", (await makeDraft(env, kp, { images: [2000] })).request)).status).toBe(201);
  });

  it("concurrent creates by one key cannot overshoot the quota", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    const drafts = await Promise.all([1, 2, 3, 4].map(() => makeDraft(env, kp, { images: [2000] })));
    const results = await Promise.all(drafts.map((d) => c.post("/submissions", d.request)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 413)).toHaveLength(2);
  });
});

describe("abandoned drafts expire", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ maxContributorStagingBytes: 5000 });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("deletes staging and ciphertext of stale draft / changes_requested submissions and refuses further writes", async () => {
    const stale = await draftSubmission(env, undefined, { images: [2500] });
    const changes = await draftSubmission(env, undefined, { images: [100] });
    const recent = await draftSubmission(env, undefined, { images: [100] });
    await env.pool.query("UPDATE submissions SET state = 'changes_requested' WHERE id = $1", [changes.id]);
    await env.pool.query("UPDATE submissions SET updated_at = now() - interval '31 days' WHERE id = ANY($1::uuid[])", [
      [stale.id, changes.id],
    ]);
    const dir = (id: string) => join(env.config.stagingDir, id);
    for (const s of [stale, changes, recent]) expect(existsSync(dir(s.id))).toBe(true);

    const staging = new StagingStore(env.config.stagingDir);
    const r = await runCleanup({ pool: env.apiPool, staging, rejectedRetentionDays: 30, draftRetentionDays: 30 });
    expect(r.draftsExpired).toBe(2);
    expect(existsSync(dir(stale.id))).toBe(false);
    expect(existsSync(dir(changes.id))).toBe(false);
    expect(existsSync(dir(recent.id))).toBe(true);
    const row = (await env.pool.query("SELECT * FROM submissions WHERE id = $1", [stale.id])).rows[0];
    expect(row.body_ciphertext).toBe("");
    expect(row.wrapped_keys).toEqual({});
    expect(row.staging_purged_at).not.toBeNull();
    expect(row.state).toBe("draft");

    // Expired: no edit, upload, completion or submit.
    const m = stale.draft.media[0]!;
    expect((await stale.c.put(`/submissions/${stale.id}`, stale.draft.request)).status).toBe(410);
    const up = await stale.c.putRaw(`/submissions/${stale.id}/media/${m.sha256}/header`, m.header);
    expect(up.status).toBe(410);
    expect(up.body.error).toBe("submission_expired");
    expect((await stale.c.post(`/submissions/${stale.id}/media/${m.sha256}/complete`)).status).toBe(410);
    expect((await stale.c.post(`/submissions/${stale.id}/submit`)).status).toBe(410);
    expect((await changes.c.post(`/submissions/${changes.id}/submit`)).status).toBe(410);
    expect(existsSync(dir(stale.id))).toBe(false);

    // Expired drafts no longer count toward the contributor's staging quota.
    const again = await makeDraft(env, stale.contributor, { images: [4000] });
    const created = await stale.c.post("/submissions", again.request);
    expect(created.status).toBe(201);
    await uploadMedia(stale.c, created.body.id, again.media[0]!);

    // The recent draft still works, and a second run is a no-op.
    expect((await recent.c.post(`/submissions/${recent.id}/submit`)).status).toBe(200);
    expect((await runCleanup({ pool: env.apiPool, staging, rejectedRetentionDays: 30 })).draftsExpired).toBe(0);
  });

  it("purges expired NIP-98 replay entries", async () => {
    await env.pool.query(
      "INSERT INTO auth_replay (event_id, expires_at) VALUES ($1, now() - interval '1 second'), ($2, now() + interval '1 minute')",
      ["1".repeat(64), "2".repeat(64)],
    );
    const r = await runCleanup({
      pool: env.apiPool, // the retention job runs in the API process, as the api role
      staging: new StagingStore(env.config.stagingDir),
      rejectedRetentionDays: 30,
    });
    expect(r.authReplayPruned).toBeGreaterThanOrEqual(1);
    const left = await env.pool.query("SELECT event_id FROM auth_replay WHERE event_id = ANY($1)", [
      ["1".repeat(64), "2".repeat(64)],
    ]);
    expect(left.rows.map((x) => x.event_id)).toEqual(["2".repeat(64)]);
  });
});
