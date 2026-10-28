import { createAuthHeader, generateKeyPair } from "@azaadawaaz/core";
import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_WINDOW_SEC, PgReplayStore } from "../src/auth.js";
import { buildServer } from "../src/server.js";
import {
  PUBLIC_URL,
  auditEvent,
  inReviewSubmission,
  newContributor,
  setup,
  submittedSubmission,
  TestClient,
  type TestEnv,
} from "./helpers.js";

describe("NIP-98 authentication", () => {
  let env: TestEnv;
  let mod: TestClient;
  beforeAll(async () => {
    env = await setup();
    mod = env.client(env.mod1);
  });
  afterAll(async () => {
    await env?.close();
  });

  it("accepts a header built with core.createAuthHeader", async () => {
    const header = createAuthHeader(PUBLIC_URL + "/queue", "GET", env.mod1.kp.secretKey);
    const r = await mod.get("/queue", { header });
    expect(r.status).toBe(200);
  });

  it("rejects a missing or malformed header", async () => {
    const none = await mod.get("/queue", { noAuth: true });
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: "unauthorized", message: "missing Nostr authorization" });
    expect((await mod.get("/queue", { header: "Bearer abc" })).status).toBe(401);
    expect((await mod.get("/queue", { header: "Nostr !!!notbase64" })).body.message).toBe("malformed authorization");
  });

  it("rejects a wrong url, path, query or host", async () => {
    for (const authUrl of [
      "http://evil.example/queue",
      PUBLIC_URL + "/queue?x=1",
      PUBLIC_URL + "/contributors",
      "https://api.test:8787/queue",
    ]) {
      const r = await mod.get("/queue", { authUrl });
      expect(r.status, authUrl).toBe(401);
      expect(r.body.message).toBe("url mismatch");
    }
    // The query string is part of the signed URL.
    const s = await submittedSubmission(env);
    const path = `/submissions/${s.id}?x25519=${env.mod1.x.publicKey}`;
    expect((await mod.get(path, { authUrl: PUBLIC_URL + `/submissions/${s.id}` })).status).toBe(401);
    expect((await mod.get(path)).status).toBe(200);
  });

  it("rejects a wrong method", async () => {
    const r = await mod.get("/queue", { authMethod: "POST" });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe("method mismatch");
  });

  it("rejects a replayed header within the window", async () => {
    const header = createAuthHeader(
      PUBLIC_URL + "/queue",
      "GET",
      env.mod1.kp.secretKey,
      undefined,
      Math.floor(Date.now() / 1000) - 5,
    );
    expect((await mod.get("/queue", { header })).status).toBe(200);
    const again = await mod.get("/queue", { header });
    expect(again.status).toBe(401);
    expect(again.body.message).toBe("authorization replayed");
  });

  it("rejects expired and future-dated headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = await mod.get("/queue", { authCreatedAt: now - 120 });
    expect(old.status).toBe(401);
    expect(old.body.message).toBe("authorization expired");
    expect((await mod.get("/queue", { authCreatedAt: now + 120 })).status).toBe(401);
    expect((await mod.get("/queue", { authCreatedAt: now - 30 })).status).toBe(200);
  });

  it("rejects a payload hash that doesn't match the raw body", async () => {
    const c = env.client(await newContributor(env));
    const body = { storyId: "x" };
    const wrong = await c.post("/submissions", body, { authBody: JSON.stringify({ storyId: "y" }) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe("payload mismatch");
    // Same JSON value, different bytes (whitespace) is still a mismatch: the hash covers the raw body.
    const ws = await c.post("/submissions", body, { authBody: JSON.stringify(body, null, 2) });
    expect(ws.body.message).toBe("payload mismatch");
    // Octet-stream bodies too.
    const s = await submittedSubmission(env);
    const raw = await s.c.putRaw(`/submissions/${s.id}/media/${s.draft.media[0]!.sha256}/header`, new Uint8Array(24), {
      authBody: new Uint8Array(24).fill(1),
    });
    expect(raw.status).toBe(401);
  });

  it("rejects a tampered or wrongly-signed event", async () => {
    const header = createAuthHeader(PUBLIC_URL + "/queue", "GET", env.mod1.kp.secretKey);
    const e = JSON.parse(atob(header.slice(6)));
    e.pubkey = env.mod2.kp.pubkey;
    expect((await mod.get("/queue", { header: `Nostr ${btoa(JSON.stringify(e))}` })).body.message).toBe(
      "bad signature",
    );
    const wrongKind = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["u", PUBLIC_URL + "/queue"],
          ["method", "GET"],
        ],
        content: "",
      },
      env.mod1.kp.secretKey,
    );
    expect((await mod.get("/queue", { header: `Nostr ${btoa(JSON.stringify(wrongKind))}` })).body.message).toBe(
      "wrong event kind",
    );
  });

  it("a replay is refused by another API process sharing the database (restart or replica)", async () => {
    const header = createAuthHeader(PUBLIC_URL + "/queue", "GET", env.mod1.kp.secretKey);
    expect((await mod.get("/queue", { header })).status).toBe(200);
    const replica = await buildServer({ config: env.config, pool: env.pool, lists: env.lists, logger: false });
    try {
      const r = await replica.inject({ method: "GET", url: "/queue", headers: { authorization: header } });
      expect(r.statusCode).toBe(401);
      expect(r.json().message).toBe("authorization replayed");
    } finally {
      await replica.close();
    }
  });

  it("remembers an auth event until its created_at + window + 1 s, in Postgres", async () => {
    const createdAt = Math.floor(Date.now() / 1000) - 50;
    const header = createAuthHeader(PUBLIC_URL + "/queue", "GET", env.mod1.kp.secretKey, undefined, createdAt);
    expect((await mod.get("/queue", { header })).status).toBe(200);
    const id = JSON.parse(atob(header.slice(6))).id;
    const row = await env.pool.query("SELECT extract(epoch FROM expires_at)::bigint AS exp FROM auth_replay WHERE event_id = $1", [
      id,
    ]);
    expect(Number(row.rows[0].exp)).toBe(createdAt + AUTH_WINDOW_SEC + 1);

    // A server whose clock says the event is still inside its window keeps refusing it until the very end of it.
    const late = await buildServer({
      config: env.config,
      pool: env.pool,
      lists: env.lists,
      logger: false,
      now: () => (createdAt + AUTH_WINDOW_SEC) * 1000,
    });
    try {
      const r = await late.inject({ method: "GET", url: "/queue", headers: { authorization: header } });
      expect(r.statusCode).toBe(401);
      expect(r.json().message).toBe("authorization replayed");
    } finally {
      await late.close();
    }

    const store = new PgReplayStore(env.pool);
    const t = 2_000_000_000;
    const fresh = "e".repeat(64);
    expect(await store.remember(fresh, t + 61, t * 1000)).toBe(true);
    expect(await store.remember(fresh, t + 61, (t + 60) * 1000)).toBe(false);
    expect(await store.remember(fresh, t + 61, (t + 60.999) * 1000)).toBe(false);
    // expired but not purged yet: reusable
    expect(await store.remember(fresh, t + 200, (t + 61) * 1000)).toBe(true);
  });

  it("answers 401 (never 500) for malformed auth events", async () => {
    const good = JSON.parse(atob(createAuthHeader(PUBLIC_URL + "/queue", "GET", env.mod1.kp.secretKey).slice(6)));
    const variants: unknown[] = [
      null,
      [],
      "string",
      42,
      { ...good, tags: null },
      { ...good, tags: "u" },
      { ...good, tags: [null] },
      { ...good, tags: [["u", 5]] },
      { ...good, tags: [[]] },
      { ...good, tags: [["u", PUBLIC_URL + "/queue"], "method"] },
      { ...good, tags: { 0: ["u"] } },
      { ...good, created_at: String(good.created_at) },
      { ...good, created_at: 1.5 },
      { ...good, kind: "27235" },
      { ...good, content: null },
      { ...good, id: 5 },
      { ...good, pubkey: "x" },
      { ...good, sig: undefined },
    ];
    for (const v of variants) {
      const header = `Nostr ${Buffer.from(JSON.stringify(v)).toString("base64")}`;
      const r = await mod.get("/queue", { header });
      expect(r.status, JSON.stringify(v)).toBe(401);
      expect(r.body.message).toBe("malformed authorization");
    }
    // Not even JSON / not base64
    for (const header of ["Nostr ", "Nostr e30", "Nostr bnVsbA==", `Nostr ${btoa("{")}`]) {
      const r = await mod.get("/queue", { header });
      expect(r.status, header).toBe(401);
    }
    expect(env.logs.text).not.toContain('"statusCode":500');
  });
});

describe("role checks", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("moderator-only routes refuse contributors and strangers; the owner may use them", async () => {
    const contributor = env.client(await newContributor(env));
    const stranger = env.client(generateKeyPair());
    for (const path of ["/queue", "/contributors", "/jobs", "/rewrap-needed"]) {
      expect((await contributor.get(path)).status, path).toBe(403);
      expect((await stranger.get(path)).status, path).toBe(403);
      expect((await env.client(env.owner).get(path)).status, path).toBe(200);
      expect((await env.client(env.mod2).get(path)).status, path).toBe(200);
    }
  });

  it("owner-only routes refuse moderators", async () => {
    const m = env.client(env.mod1);
    for (const path of ["/audit", "/owner/alerts"]) {
      const r = await m.get(path);
      expect(r.status, path).toBe(403);
      expect(r.body.error).toBe("forbidden");
      expect((await env.client(env.owner).get(path)).status).toBe(200);
    }
    expect((await m.post("/invites/revoke", { inviteId: "a".repeat(64) })).status).toBe(403);
    expect((await m.post("/owner/alerts/seen", {})).status).toBe(403);
    expect((await m.post(`/jobs/${"0b9c3a2e-1111-4222-8333-444455556666"}/retry`)).status).toBe(403);
  });

  it("contributor routes refuse moderators and strangers", async () => {
    const stranger = env.client(generateKeyPair());
    expect((await stranger.post("/submissions", {})).status).toBe(403);
    expect((await stranger.get("/me/submissions")).status).toBe(403);
    expect((await env.client(env.mod1).post("/submissions", {})).status).toBe(403);
  });

  it("a contributor can't see or touch someone else's submission", async () => {
    const s = await submittedSubmission(env);
    const other = env.client(await newContributor(env));
    const m = s.draft.media[0]!;
    expect((await other.get(`/submissions/${s.id}`)).status).toBe(404);
    expect((await other.get(`/submissions/${s.id}/media/${m.sha256}/status`)).status).toBe(404);
    expect((await other.get(`/submissions/${s.id}/media/${m.sha256}/chunks/0`)).status).toBe(404);
    expect((await other.post(`/submissions/${s.id}/submit`)).status).toBe(404);
    expect((await other.put(`/submissions/${s.id}`, s.draft.request)).status).toBe(404);
    expect((await env.client(generateKeyPair()).get(`/submissions/${s.id}`)).status).toBe(404);
    // the owner, moderators and the contributor can
    expect((await s.c.get(`/submissions/${s.id}`)).status).toBe(200);
    expect((await env.client(env.owner).get(`/submissions/${s.id}`)).status).toBe(200);
    expect((await env.client(env.mod2).get(`/submissions/${s.id}/media/${m.sha256}/header`)).status).toBe(200);
  });

  it("contributors can't moderate; a removed moderator loses access immediately", async () => {
    const s = await inReviewSubmission(env);
    const r = await s.c.post(`/submissions/${s.id}/reject`, {
      feedback: "A".repeat(200),
      auditEvent: auditEvent(s.contributor, "reject", { submissionId: s.id }),
    });
    expect(r.status).toBe(403);
    env.setModerators([{ actor: env.mod1 }, { actor: env.mod2, until: Math.floor(Date.now() / 1000) - 1 }]);
    try {
      expect((await env.client(env.mod2).get("/queue")).status).toBe(403);
      expect((await env.client(env.mod2).post(`/submissions/${s.id}/claim`)).status).toBe(403);
    } finally {
      env.setModerators([{ actor: env.mod1 }, { actor: env.mod2 }]);
    }
  });

  it("x25519 must be the caller's own listed key", async () => {
    const s = await submittedSubmission(env);
    const r = await env.client(env.mod1).get(`/submissions/${s.id}?x25519=${env.mod2.x.publicKey}`);
    expect(r.status).toBe(403);
    const own = await s.c.get(`/submissions/${s.id}?x25519=${env.mod2.x.publicKey}`);
    expect(own.status).toBe(403);
    const ok = await env.client(env.owner).get(`/submissions/${s.id}?x25519=${env.owner.x.publicKey}`);
    expect(ok.body.wrappedKey).toMatch(/^[A-Za-z0-9_-]{107}$/);
    expect(ok.body.wrappedKeys).toBeUndefined();
    expect(JSON.stringify(ok.body)).not.toContain(s.draft.request.wrappedKeys[env.mod1.x.publicKey]!);
    expect((await s.c.get(`/submissions/${s.id}?x25519=nothex`)).status).toBe(400);
  });
});

describe("HTTP hygiene", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("sets security headers and JSON errors", async () => {
    const r = await env.app.inject({ method: "GET", url: "/health" });
    expect(r.json()).toEqual({ ok: true });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cache-control"]).toBe("no-store");
    const nf = await env.app.inject({ method: "GET", url: "/nope" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: "not_found", message: "no such endpoint" });
  });

  it("allows CORS only from configured origins, without credentials", async () => {
    const ok = await env.app.inject({
      method: "OPTIONS",
      url: "/queue",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    const bad = await env.app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects malformed JSON, wrong content types and oversized bodies", async () => {
    const c = env.client(await newContributor(env));
    const bad = await env.app.inject({
      method: "POST",
      url: "/invites/redeem",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_json");
    const txt = await env.app.inject({
      method: "POST",
      url: "/invites/redeem",
      headers: { "content-type": "text/plain" },
      payload: "hi",
    });
    expect(txt.statusCode).toBe(415);
    const s = await submittedSubmission(env);
    const big = await s.c.putRaw(
      `/submissions/${s.id}/media/${s.draft.media[0]!.sha256}/chunks/0`,
      new Uint8Array(1024 * 1024 + 18),
    );
    expect(big.status).toBe(413);
    expect(big.body.error).toBe("payload_too_large");
    expect((await c.post("/submissions", { storyId: 1 })).body.error).toBe("invalid_body");
  });

  it("serves under a path prefix and accepts every configured public URL", async () => {
    const app = await buildServer({
      config: {
        ...env.config,
        publicUrls: ["https://azaadawaaz.example/api", "http://onionaddress.onion/api"],
        basePath: "/api",
      },
      pool: env.pool,
      lists: env.lists,
      logger: false,
    });
    try {
      const c = new TestClient(app, env.mod1.kp);
      expect((await c.get("/api/queue", { authUrl: "https://azaadawaaz.example/api/queue" })).status).toBe(200);
      expect((await c.get("/api/queue", { authUrl: "http://onionaddress.onion/api/queue" })).status).toBe(200);
      expect((await c.get("/api/queue", { authUrl: "https://azaadawaaz.example/api/api/queue" })).status).toBe(401);
      expect((await c.get("/api/queue", { authUrl: "https://other.example/api/queue" })).status).toBe(401);
      const h = await app.inject({ method: "GET", url: "/api/health" });
      expect(h.headers["strict-transport-security"]).toContain("max-age=");
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
