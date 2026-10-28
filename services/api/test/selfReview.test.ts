import { createInvite, createRedemption, type KeyPair } from "@azaadawaaz/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvePayload,
  auditEvent,
  feedbackFor,
  submittedSubmission,
  setup,
  type Actor,
  type Sub,
  type TestEnv,
} from "./helpers.js";

describe("nobody reviews their own submission", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  /** A staff key that also redeemed an invite, and submitted with it; `reviewer` claims it. */
  async function ownSubmission(author: KeyPair, reviewer: Actor): Promise<Sub> {
    const invite = createInvite(env.owner.kp.secretKey, { note: "staff writes too" });
    const redeem = await env
      .client(author)
      .post("/invites/redeem", { redemption: createRedemption(invite.event, author.secretKey) }, { noAuth: true });
    expect([201, 409]).toContain(redeem.status); // 409: already a contributor from an earlier test
    const s = await submittedSubmission(env, author);
    expect((await env.client(reviewer).post(`/submissions/${s.id}/claim`)).status).toBe(200);
    return s;
  }

  it("a moderator cannot approve, reject or request changes on their own submission", async () => {
    const s = await ownSubmission(env.mod1.kp, env.mod2);
    const me = env.client(env.mod1);
    const { payload } = await approvePayload(env, env.mod1, s);
    const approve = await me.post(`/submissions/${s.id}/approve`, payload);
    expect(approve.status).toBe(403);
    expect(approve.body.error).toBe("forbidden");
    for (const [path, action] of [
      ["reject", "reject"],
      ["request-changes", "request_changes"],
    ] as const) {
      const r = await me.post(`/submissions/${s.id}/${path}`, {
        feedback: feedbackFor(env.mod1.kp, env.mod1.kp.pubkey, "looks fine to me"),
        auditEvent: auditEvent(env.mod1.kp, action, { submissionId: s.id }),
      });
      expect(r.status, path).toBe(403);
    }
    const row = (await env.pool.query("SELECT state FROM submissions WHERE id = $1", [s.id])).rows[0];
    expect(row.state).toBe("in_review");
    expect(
      (await env.pool.query("SELECT count(*)::int AS n FROM publish_jobs WHERE submission_id = $1", [s.id])).rows[0].n,
    ).toBe(0);
    expect(
      env.forwarded.events.some(
        (e) => e.pubkey === env.mod1.kp.pubkey && e.tags.some((t) => t[0] === "action" && t[1] === "approve"),
      ),
    ).toBe(false);

    // Another moderator can.
    const other = await approvePayload(env, env.mod2, s);
    expect((await env.client(env.mod2).post(`/submissions/${s.id}/approve`, other.payload)).status).toBe(200);
  });

  it("applies to the owner too", async () => {
    const s = await ownSubmission(env.owner.kp, env.mod1);
    const { payload } = await approvePayload(env, env.owner, s);
    expect((await env.client(env.owner).post(`/submissions/${s.id}/approve`, payload)).status).toBe(403);
    const r = await env.client(env.owner).post(`/submissions/${s.id}/reject`, {
      feedback: feedbackFor(env.owner.kp, env.owner.kp.pubkey, "no"),
      auditEvent: auditEvent(env.owner.kp, "reject", { submissionId: s.id }),
    });
    expect(r.status).toBe(403);
  });
});
