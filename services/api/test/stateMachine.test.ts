import { decryptJson, unwrapKey } from "@azaadawaaz/core";
import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  STATES,
  TRANSITIONS,
  TransitionError,
  canTransition,
  nextState,
  transition,
  type Action,
  type State,
} from "../src/stateMachine.js";
import {
  approvePayload,
  auditEvent,
  draftSubmission,
  feedbackFor,
  inReviewSubmission,
  makeDraft,
  setup,
  submittedSubmission,
  type Sub,
  type TestEnv,
} from "./helpers.js";

/** The spec §5.1 diagram, written out independently of the implementation. */
const EXPECTED: Record<Action, Partial<Record<State, State>>> = {
  edit: { draft: "draft", changes_requested: "changes_requested" },
  upload: { draft: "draft", changes_requested: "changes_requested" },
  submit: { draft: "submitted", changes_requested: "submitted" },
  claim: { submitted: "in_review", in_review: "in_review" },
  approve: { in_review: "approved" },
  reject: { in_review: "rejected" },
  request_changes: { in_review: "changes_requested" },
  rewrap: { draft: "draft", submitted: "submitted", in_review: "in_review", changes_requested: "changes_requested" },
  start_publishing: { approved: "publishing", publishing: "publishing" },
  mark_published: { publishing: "published" },
  unlist: { published: "unlisted" },
};

describe("transition table", () => {
  it("matches the spec for every action and every state", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const action of Object.keys(EXPECTED) as Action[]) {
      for (const from of STATES) {
        const want = EXPECTED[action][from];
        expect(canTransition(action, from), `${action} from ${from}`).toBe(want !== undefined);
        if (want) expect(nextState(action, from)).toBe(want);
        else expect(() => nextState(action, from)).toThrow(TransitionError);
      }
    }
  });

  it("rejected, unlisted are final; nothing leads back to draft", () => {
    for (const action of Object.keys(TRANSITIONS) as Action[]) {
      expect(canTransition(action, "rejected")).toBe(false);
      expect(canTransition(action, "unlisted")).toBe(false);
      expect(TRANSITIONS[action].to).not.toBe("draft");
    }
  });
});

describe("state transitions over HTTP", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  const state = async (id: string) =>
    (await env.pool.query("SELECT state FROM submissions WHERE id = $1", [id])).rows[0].state as State;
  const reject = (s: Sub, by = env.mod1) =>
    env.client(by).post(`/submissions/${s.id}/reject`, {
      feedback: feedbackFor(by.kp, s.contributor.pubkey, "Not verifiable."),
      auditEvent: auditEvent(by.kp, "reject", { submissionId: s.id }),
    });
  const requestChanges = (s: Sub, text = "Please blur the faces.", by = env.mod1) =>
    env.client(by).post(`/submissions/${s.id}/request-changes`, {
      feedback: feedbackFor(by.kp, s.contributor.pubkey, text),
      auditEvent: auditEvent(by.kp, "request_changes", { submissionId: s.id }),
    });
  const approve = async (s: Sub, by = env.mod1) =>
    env.client(by).post(`/submissions/${s.id}/approve`, (await approvePayload(env, by, s)).payload);

  it("draft → submitted; a submitted submission can't be submitted, edited or uploaded to", async () => {
    const s = await draftSubmission(env);
    expect(await state(s.id)).toBe("draft");
    const r = await s.c.post(`/submissions/${s.id}/submit`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("submitted");
    expect((await s.c.post(`/submissions/${s.id}/submit`)).status).toBe(409);
    const edit = await s.c.put(`/submissions/${s.id}`, s.draft.request);
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe("invalid_state");
    const m = s.draft.media[0]!;
    expect((await s.c.putRaw(`/submissions/${s.id}/media/${m.sha256}/chunks/0`, m.chunks[0]!)).status).toBe(409);
    expect((await s.c.putRaw(`/submissions/${s.id}/media/${m.sha256}/header`, m.header)).status).toBe(409);
    expect((await s.c.post(`/submissions/${s.id}/media/${m.sha256}/complete`)).status).toBe(409);
  });

  it("a draft can't be claimed, approved, rejected or sent back", async () => {
    const s = await draftSubmission(env);
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/claim`)).status).toBe(409);
    expect((await approve(s)).status).toBe(409);
    expect((await reject(s)).status).toBe(409);
    expect((await requestChanges(s)).status).toBe(409);
    expect(await state(s.id)).toBe("draft");
  });

  it("submitted → in_review by claim; the claim is advisory, refreshable and expires", async () => {
    const s = await submittedSubmission(env);
    expect((await approve(s)).status).toBe(409); // decisions need in_review (claim first)
    expect((await reject(s)).status).toBe(409);
    expect((await requestChanges(s)).status).toBe(409);
    const m1 = env.client(env.mod1);
    const r = await m1.post(`/submissions/${s.id}/claim`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "in_review", claimBy: env.mod1.kp.pubkey });
    const until = Date.parse(r.body.claimUntil);
    expect(until - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(until - Date.now()).toBeLessThan(31 * 60_000);
    // Another moderator can't take an active claim...
    const other = await env.client(env.mod2).post(`/submissions/${s.id}/claim`);
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("claimed");
    // ...the holder can refresh it...
    expect((await m1.post(`/submissions/${s.id}/claim`)).status).toBe(200);
    // ...and once it expires anyone can claim.
    await env.pool.query("UPDATE submissions SET claim_until = now() - interval '1 minute' WHERE id = $1", [s.id]);
    const q = await m1.get("/queue");
    expect(q.body.find((x: { id: string }) => x.id === s.id)).toMatchObject({ state: "in_review", claimBy: null });
    const takeover = await env.client(env.mod2).post(`/submissions/${s.id}/claim`);
    expect(takeover.status).toBe(200);
    expect(takeover.body.claimBy).toBe(env.mod2.kp.pubkey);
    // A claim never blocks a decision by another moderator.
    expect((await approve(s, env.mod1)).status).toBe(200);
  });

  it("in_review → approved creates the publish job; approved accepts nothing else", async () => {
    const s = await inReviewSubmission(env);
    const r = await approve(s);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("approved");
    const row = (await env.pool.query("SELECT * FROM submissions WHERE id = $1", [s.id])).rows[0];
    expect(row.approval.moderator).toBe(env.mod1.kp.npub);
    expect(row.publisher_wrapped_key).toMatch(/^[A-Za-z0-9_-]{107}$/);
    expect(row.decided_at).not.toBeNull();
    const job = (await env.pool.query("SELECT * FROM publish_jobs WHERE submission_id = $1", [s.id])).rows[0];
    expect(job.state).toBe("pending");
    expect((await approve(s, env.mod2)).status).toBe(409);
    expect((await reject(s)).status).toBe(409);
    expect((await requestChanges(s)).status).toBe(409);
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/claim`)).status).toBe(409);
    expect((await s.c.post(`/submissions/${s.id}/submit`)).status).toBe(409);
    expect((await s.c.put(`/submissions/${s.id}`, s.draft.request)).status).toBe(409);
    expect(await state(s.id)).toBe("approved");
  });

  it("in_review → rejected is final", async () => {
    const s = await inReviewSubmission(env);
    const r = await reject(s);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("rejected");
    expect((await env.client(env.mod2).post(`/submissions/${s.id}/claim`)).status).toBe(409);
    expect((await approve(s, env.mod2)).status).toBe(409);
    expect((await requestChanges(s)).status).toBe(409);
    expect((await reject(s)).status).toBe(409);
    expect((await s.c.post(`/submissions/${s.id}/submit`)).status).toBe(409);
    expect((await s.c.put(`/submissions/${s.id}`, s.draft.request)).status).toBe(409);
    // The contributor sees the reason (decryptable only by them).
    const mine = await s.c.get("/me/submissions");
    const fb = mine.body.find((x: { id: string }) => x.id === s.id).feedback;
    expect(fb).toHaveLength(1);
    expect(fb[0].kind).toBe("reject");
    expect(nip44Decrypt(fb[0].nip44, getConversationKey(s.contributor.secretKey, env.mod1.kp.pubkey))).toBe(
      "Not verifiable.",
    );
  });

  it("request changes → edit → resubmit keeps the full history", async () => {
    const s = await inReviewSubmission(env);
    const r = await requestChanges(s, "Please blur the faces.");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("changes_requested");
    // changes_requested can't be decided or claimed
    expect((await approve(s)).status).toBe(409);
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/claim`)).status).toBe(409);
    expect((await reject(s)).status).toBe(409);

    // The contributor reads the notes, edits (same content key, new title, new image) and resubmits.
    const mine = await s.c.get("/me/submissions");
    const fb = mine.body.find((x: { id: string }) => x.id === s.id).feedback[0];
    expect(nip44Decrypt(fb.nip44, getConversationKey(s.contributor.secretKey, env.mod1.kp.pubkey))).toBe(
      "Please blur the faces.",
    );
    const edited = await makeDraft(env, s.contributor, {
      storyId: s.draft.storyId,
      title: "Floods in the valley (faces blurred)",
      contentKey: s.draft.contentKey,
      images: [2000],
    });
    const put = await s.c.put(`/submissions/${s.id}`, edited.request);
    expect(put.status).toBe(200);
    expect(put.body.state).toBe("changes_requested");
    expect((await s.c.post(`/submissions/${s.id}/submit`)).body.error).toBe("media_incomplete");
    const { uploadMedia } = await import("./helpers.js");
    await uploadMedia(s.c, s.id, edited.media[0]!);
    // The old image's staging files were removed with it.
    const oldStatus = await s.c.get(`/submissions/${s.id}/media/${s.draft.media[0]!.sha256}/status`);
    expect(oldStatus.status).toBe(404);
    const re = await s.c.post(`/submissions/${s.id}/submit`);
    expect(re.status).toBe(200);
    expect(re.body.state).toBe("submitted");

    const view = await env.client(env.mod2).get(`/submissions/${s.id}?x25519=${env.mod2.x.publicKey}`);
    expect(view.status).toBe(200);
    expect(view.body.history.map((h: { event: string }) => h.event)).toEqual([
      "created",
      "submitted",
      "claimed",
      "changes_requested",
      "edited",
      "submitted",
    ]);
    expect(view.body.feedback).toHaveLength(1);
    // The reviewed (previous) version is still readable by moderators.
    const prev = view.body.history.find((h: { event: string }) => h.event === "edited").previous;
    const key = await unwrapKey(prev.wrappedKey, env.mod2.x);
    expect((await decryptJson<{ title: { en: string } }>(prev.bodyCiphertext, key)).title.en).toBe(
      "Floods in the valley",
    );
    const cur = await decryptJson<{ title: { en: string } }>(
      view.body.bodyCiphertext,
      await unwrapKey(view.body.wrappedKey, env.mod2.x),
    );
    expect(cur.title.en).toBe("Floods in the valley (faces blurred)");
    // It can now go through review again.
    expect((await env.client(env.mod2).post(`/submissions/${s.id}/claim`)).status).toBe(200);
    expect((await approve(s, env.mod2)).status).toBe(200);
  });

  it("approved → publishing → published (publisher), then published → unlisted", async () => {
    const s = await inReviewSubmission(env);
    expect((await approve(s)).status).toBe(200);
    let skew = 0; // distinct audit events (an identical event id is rejected as a replay)
    const unlist = (by = env.mod1) =>
      env.client(by).post("/moderation/unlist", {
        storyId: s.draft.storyId,
        auditEvent: auditEvent(by.kp, "unlist", { storyId: s.draft.storyId }, Math.floor(Date.now() / 1000) - skew++),
      });
    // Unlisting before publication changes no state.
    const early = await unlist();
    expect(early.status).toBe(200);
    expect(early.body.unlisted).toBe(0);
    expect(await state(s.id)).toBe("approved");

    await expect(transition(env.pool, "mark_published", { id: s.id })).rejects.toBeInstanceOf(TransitionError);
    expect((await transition(env.pool, "start_publishing", { id: s.id })).state).toBe("publishing");
    expect((await transition(env.pool, "start_publishing", { id: s.id })).state).toBe("publishing"); // retry
    expect((await transition(env.pool, "mark_published", { id: s.id })).state).toBe("published");
    await expect(transition(env.pool, "start_publishing", { id: s.id })).rejects.toBeInstanceOf(TransitionError);

    const r = await unlist(env.mod2);
    expect(r.status).toBe(200);
    expect(r.body.unlisted).toBe(1);
    expect(await state(s.id)).toBe("unlisted");
    expect((await unlist()).body.unlisted).toBe(0);
    await expect(transition(env.pool, "unlist", { id: s.id })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("re-wrapping is only possible while a submission is under moderation", async () => {
    const s = await inReviewSubmission(env);
    expect((await env.client(env.mod1).post(`/submissions/${s.id}/keys`, { wrappedKeys: s.draft.request.wrappedKeys })).status).toBe(200);
    expect((await approve(s)).status).toBe(200);
    const r = await env.client(env.mod1).post(`/submissions/${s.id}/keys`, { wrappedKeys: s.draft.request.wrappedKeys });
    expect(r.status).toBe(409);
  });

  it("unknown submissions are 404, not 409", async () => {
    const id = "0b9c3a2e-1111-4222-8333-444455556666";
    expect((await env.client(env.mod1).post(`/submissions/${id}/claim`)).status).toBe(404);
    expect((await env.client(env.mod1).post(`/submissions/not-a-uuid/claim`)).status).toBe(404);
    await expect(transition(env.pool, "approve", { id })).rejects.toMatchObject({ statusCode: 404 });
  });
});
