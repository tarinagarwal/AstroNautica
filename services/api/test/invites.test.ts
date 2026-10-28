import { createInvite, createListEvent, createRedemption, generateKeyPair, type Event } from "@azaadawaaz/core";
import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvent, draftSubmission, makeDraft, newContributor, setup, type TestEnv } from "./helpers.js";

describe("invite redemption", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  const redeem = (redemption: unknown) =>
    env.client(generateKeyPair()).post("/invites/redeem", { redemption }, { noAuth: true });

  it("redeems a valid owner-signed invite and records the chain", async () => {
    const kp = generateKeyPair();
    const invite = createInvite(env.owner.kp.secretKey, {
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      note: "for the valley desk",
    });
    const redemption = createRedemption(invite.event, kp.secretKey);
    const r = await redeem(redemption);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ contributor: kp.pubkey });
    const row = (await env.pool.query("SELECT * FROM contributors WHERE pubkey = $1", [kp.pubkey])).rows[0];
    expect(row.invite_id).toBe(invite.event.id);
    expect(row.redemption.id).toBe(redemption.id);
    const used = (await env.pool.query("SELECT * FROM invites_used WHERE invite_id = $1", [invite.event.id])).rows[0];
    expect(used.contributor).toBe(kp.pubkey);
    expect(used.code_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(used.code_sha256).not.toBe(invite.code);
    // the new contributor can work right away
    const contributors = await env.client(env.mod1).get("/contributors");
    expect(contributors.body.map((c: { pubkey: string }) => c.pubkey)).toContain(kp.pubkey);
  });

  it("rejects an expired invite", async () => {
    const invite = createInvite(env.owner.kp.secretKey, { expiresAt: Math.floor(Date.now() / 1000) - 1 });
    const r = await redeem(createRedemption(invite.event, generateKeyPair().secretKey));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invite_expired");
  });

  it("rejects a reused invite (by a second key, and concurrently)", async () => {
    const invite = createInvite(env.owner.kp.secretKey);
    expect((await redeem(createRedemption(invite.event, generateKeyPair().secretKey))).status).toBe(201);
    const again = await redeem(createRedemption(invite.event, generateKeyPair().secretKey));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("invite_used");

    const invite2 = createInvite(env.owner.kp.secretKey);
    const results = await Promise.all(
      [0, 1, 2].map(() => redeem(createRedemption(invite2.event, generateKeyPair().secretKey))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it("rejects a second invite with the same code (a re-signed copy)", async () => {
    const first = createInvite(env.owner.kp.secretKey, { code: "c".repeat(32) });
    expect((await redeem(createRedemption(first.event, generateKeyPair().secretKey))).status).toBe(201);
    const copy = createInvite(env.owner.kp.secretKey, { code: "c".repeat(32), note: "copy" });
    expect((await redeem(createRedemption(copy.event, generateKeyPair().secretKey))).body.error).toBe("invite_used");
  });

  it("rejects a revoked invite", async () => {
    const invite = createInvite(env.owner.kp.secretKey);
    const rv = await env.client(env.owner).post("/invites/revoke", { inviteId: invite.event.id });
    expect(rv.status).toBe(200);
    const r = await redeem(createRedemption(invite.event, generateKeyPair().secretKey));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("invite_revoked");
  });

  it("rejects forged invites and redemptions", async () => {
    // signed by someone other than the owner
    const notOwner = createInvite(env.mod1.kp.secretKey);
    const r1 = await redeem(createRedemption(notOwner.event, generateKeyPair().secretKey));
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe("invalid_invite");
    expect(r1.body.message).toBe("invite is not signed by the owner");
    // owner pubkey but edited content (e.g. extended expiry)
    const real = createInvite(env.owner.kp.secretKey, { expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const edited: Event = { ...real.event, content: JSON.stringify({ ...JSON.parse(real.event.content), expiresAt: 9e9 }) };
    const r2 = await redeem(createRedemption(edited, generateKeyPair().secretKey));
    expect(r2.status).toBe(400);
    expect(r2.body.message).toBe("bad invite signature");
    // redemption whose e tag doesn't match the embedded invite
    const ok = createInvite(env.owner.kp.secretKey);
    const kp = generateKeyPair();
    const mismatch = finalizeEvent(
      { kind: 9740, created_at: Math.floor(Date.now() / 1000), tags: [["e", "f".repeat(64)]], content: JSON.stringify(ok.event) },
      kp.secretKey,
    );
    expect((await redeem(mismatch)).body.message).toBe("redemption does not match invite");
    // tampered redemption signature
    const red = createRedemption(ok.event, kp.secretKey);
    expect((await redeem({ ...red, pubkey: generateKeyPair().pubkey })).body.message).toBe("bad redemption");
    // garbage
    expect((await redeem("nope")).status).toBe(400);
    // the valid one still works afterwards
    expect((await redeem(red)).status).toBe(201);
  });

  it("rejects a key that is already a contributor", async () => {
    const kp = await newContributor(env);
    const invite = createInvite(env.owner.kp.secretKey);
    const r = await env.client(kp).post("/invites/redeem", { redemption: createRedemption(invite.event, kp.secretKey) }, {
      noAuth: true,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("already_contributor");
  });
});

describe("contributor revocation", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("a revoked contributor can't create, edit, upload or submit, but can still read their own status", async () => {
    const s = await draftSubmission(env);
    const pk = s.contributor.pubkey;
    const bad = await env.client(env.mod1).post(`/contributors/${pk}/revoke`, {
      auditEvent: auditEvent(env.mod1.kp, "revoke_contributor", { p: env.mod2.kp.pubkey }),
    });
    expect(bad.status).toBe(400);
    const r = await env.client(env.mod1).post(`/contributors/${pk}/revoke`, {
      auditEvent: auditEvent(env.mod1.kp, "revoke_contributor", { p: pk }),
    });
    expect(r.status).toBe(200);
    expect(r.body.pubkey).toBe(pk);
    const again = await env.client(env.mod2).post(`/contributors/${pk}/revoke`, {
      auditEvent: auditEvent(env.mod2.kp, "revoke_contributor", { p: pk }),
    });
    expect(again.status).toBe(409);

    const draft = await makeDraft(env, s.contributor);
    const create = await s.c.post("/submissions", draft.request);
    expect(create.status).toBe(403);
    expect(create.body.message).toBe("this contributor has been revoked");
    expect((await s.c.put(`/submissions/${s.id}`, s.draft.request)).status).toBe(403);
    expect((await s.c.post(`/submissions/${s.id}/submit`)).status).toBe(403);
    expect((await s.c.putRaw(`/submissions/${s.id}/media/${s.draft.media[0]!.sha256}/header`, s.draft.media[0]!.header)).status).toBe(403);
    expect((await s.c.get("/me/submissions")).status).toBe(200);
    expect((await s.c.get(`/submissions/${s.id}`)).status).toBe(200);

    const list = await env.client(env.mod1).get("/contributors");
    expect(list.body.find((c: { pubkey: string }) => c.pubkey === pk).revokedAt).not.toBeNull();
    const audit = await env.client(env.owner).get("/audit");
    expect(audit.body.events.some((e: { action: string; actor: string }) => e.action === "revoke_contributor" && e.actor === env.mod1.kp.pubkey)).toBe(true);
    expect(
      env.forwarded.events.some((e) => e.pubkey === env.mod1.kp.pubkey && e.tags.some((t) => t[0] === "p" && t[1] === pk)),
    ).toBe(true);
    const alerts = await env.client(env.owner).get("/owner/alerts");
    expect(alerts.body.some((a: { kind: string }) => a.kind === "contributor_revoked")).toBe(true);
    // unknown contributor
    const unknown = generateKeyPair().pubkey;
    expect(
      (await env.client(env.mod1).post(`/contributors/${unknown}/revoke`, { auditEvent: auditEvent(env.mod1.kp, "revoke_contributor", { p: unknown }) })).status,
    ).toBe(404);
  });

  it("a contributor on a moderator's signed revoked list is blocked too", async () => {
    const kp = await newContributor(env);
    const draft = await makeDraft(env, kp);
    env.lists.feed([createListEvent("revoked-contributors", [[kp.pubkey, Math.floor(Date.now() / 1000)]], env.mod2.kp.secretKey)]);
    const r = await env.client(kp).post("/submissions", draft.request);
    expect(r.status).toBe(403);
  });
});
