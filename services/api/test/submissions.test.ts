import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CHUNK_SIZE, decryptBytes, generateEncryptionKeyPair, unwrapKey, wrapKey } from "@azaadawaaz/core";
import { sha256Hex } from "@azaadawaaz/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ListsService } from "../src/lists.js";
import { buildServer } from "../src/server.js";
import { expectedChunkBytes } from "../src/staging.js";
import {
  draftSubmission,
  makeDraft,
  newActor,
  newContributor,
  setup,
  submittedSubmission,
  TestClient,
  type TestEnv,
} from "./helpers.js";

describe("creating and editing submissions", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ submissionsPerHour: 3, maxImageBytes: 5 * 1024 * 1024, maxBlocks: 1 });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("creates a draft with the encrypted body and media list", async () => {
    const kp = await newContributor(env);
    const d = await makeDraft(env, kp, { images: [10, 2 * CHUNK_SIZE + 5] });
    const r = await env.client(kp).post("/submissions", d.request);
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    const row = (await env.pool.query("SELECT * FROM submissions WHERE id = $1", [r.body.id])).rows[0];
    expect(row.state).toBe("draft");
    expect(row.contributor).toBe(kp.pubkey);
    expect(row.media.map((m: { chunks: number; complete: boolean }) => [m.chunks, m.complete])).toEqual([
      [1, false],
      [3, false],
    ]);
  });

  it("requires wraps for the owner and every active moderator", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    const noOwner = await makeDraft(env, kp, { recipients: [env.mod1.x.publicKey, env.mod2.x.publicKey] });
    const r1 = await c.post("/submissions", noOwner.request);
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe("missing_wrapped_keys");
    expect(r1.body.message).toContain(env.owner.x.publicKey);
    const noMod2 = await makeDraft(env, kp, { recipients: [env.owner.x.publicKey, env.mod1.x.publicKey] });
    expect((await c.post("/submissions", noMod2.request)).body.message).toContain(env.mod2.x.publicKey);
    // the publisher must never get a pre-approval wrap
    const withPublisher = await makeDraft(env, kp, {
      recipients: [env.owner.x.publicKey, env.mod1.x.publicKey, env.mod2.x.publicKey, env.publisher.x.publicKey],
    });
    expect((await c.post("/submissions", withPublisher.request)).body.error).toBe("publisher_wrap_forbidden");
    // a malformed wrap
    const bad = await makeDraft(env, kp);
    bad.request.wrappedKeys[env.mod1.x.publicKey] = "short";
    expect((await c.post("/submissions", bad.request)).body.error).toBe("invalid_body");
    // an extra recipient (the contributor's own device key) is fine, and they can fetch it back
    const device = await generateEncryptionKeyPair();
    const extra = await makeDraft(env, kp, {
      recipients: [env.owner.x.publicKey, env.mod1.x.publicKey, env.mod2.x.publicKey, device.publicKey],
    });
    const ok = await c.post("/submissions", extra.request);
    expect(ok.status).toBe(201);
    const view = await c.get(`/submissions/${ok.body.id}?x25519=${device.publicKey}`);
    expect(Buffer.from(await unwrapKey(view.body.wrappedKey, device))).toEqual(Buffer.from(extra.contentKey));
  });

  it("refuses new submissions with 503 until the signed lists are loaded", async () => {
    const empty = new ListsService({ ownerPubkey: env.owner.kp.pubkey });
    const app = await buildServer({ config: env.config, pool: env.pool, lists: empty, logger: false });
    try {
      const kp = await newContributor(env);
      const d = await makeDraft(env, kp);
      const r = await new TestClient(app, kp).post("/submissions", d.request);
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("lists_unavailable");
    } finally {
      await app.close();
    }
  });

  it("validates media limits and chunk counts", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    const d = await makeDraft(env, kp);
    const m = d.request.media[0]!;
    const cases: [object, string][] = [
      [{ ...m, chunks: 2 }, "invalid_media"],
      [{ ...m, size: 6 * 1024 * 1024, chunks: 6 }, "media_too_large"],
      [{ ...m, mime: "image/svg+xml" }, "invalid_body"],
      [{ ...m, kind: "video" }, "invalid_body"], // image mime on a video
      [{ ...m, sha256: "../../etc/passwd" }, "invalid_body"],
      [{ ...m, size: 0 }, "invalid_body"],
      [{ ...m, extra: 1 }, "invalid_body"],
    ];
    for (const [media, code] of cases) {
      const r = await c.post("/submissions", { ...d.request, media: [media] });
      expect(r.status, JSON.stringify(media)).toBe(400);
      expect(r.body.error, JSON.stringify(media)).toBe(code);
    }
    expect((await c.post("/submissions", { ...d.request, media: [m, m] })).body.message).toContain("listed twice");
    // MAX_BLOCKS=1 → at most 20 media items
    const many = Array.from({ length: 21 }, (_, i) => ({ ...m, sha256: sha256Hex(String(i)) }));
    expect((await c.post("/submissions", { ...d.request, media: many })).status).toBe(400);
    // a video may be large
    const video = { sha256: sha256Hex("v"), size: 100 * 1024 * 1024, mime: "video/mp4", kind: "video", chunks: 100 };
    expect((await c.post("/submissions", { ...d.request, media: [video] })).status).toBe(201);
  });

  it("validates the story fields", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    const d = await makeDraft(env, kp);
    for (const body of [
      { ...d.request, storyId: "01928f3e-7c1a-4b2c-8d3e-4f5a6b7c8d9e" }, // v4, not v7
      { ...d.request, version: 2, supersedes: null },
      { ...d.request, version: 1, supersedes: "a".repeat(64) },
      { ...d.request, bodyCiphertext: "plain text" },
      { ...d.request, wrappedKeys: {} },
      { ...d.request, unknown: true },
    ]) {
      expect((await c.post("/submissions", body)).status).toBe(400);
    }
  });

  it("rate-limits new submissions per key", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    for (let i = 0; i < 3; i++)
      expect((await c.post("/submissions", (await makeDraft(env, kp)).request)).status).toBe(201);
    const r = await c.post("/submissions", (await makeDraft(env, kp)).request);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("rate_limited");
    const events = await env.pool.query("SELECT count(*)::int AS n FROM rate_events WHERE pubkey = $1", [kp.pubkey]);
    expect(events.rows[0].n).toBe(3);
  });

  it("protects story ids and versions", async () => {
    const a = await newContributor(env);
    const b = await newContributor(env);
    const d = await makeDraft(env, a);
    expect((await env.client(a).post("/submissions", d.request)).status).toBe(201);
    expect((await env.client(a).post("/submissions", d.request)).body.error).toBe("version_exists");
    const steal = await makeDraft(env, b, { storyId: d.storyId, version: 2, supersedes: "b".repeat(64) });
    expect((await env.client(b).post("/submissions", steal.request)).body.error).toBe("story_not_yours");
    const v2 = await makeDraft(env, a, { storyId: d.storyId, version: 2, supersedes: "b".repeat(64) });
    expect((await env.client(a).post("/submissions", v2.request)).status).toBe(201);
  });
});

describe("chunked media upload", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("uploads, resumes after an interruption, completes, and moderators download what was sent", async () => {
    const kp = await newContributor(env);
    const c = env.client(kp);
    const d = await makeDraft(env, kp, { images: [2 * CHUNK_SIZE + 1234] });
    const { id } = (await c.post("/submissions", d.request)).body;
    const m = d.media[0]!;
    const base = `/submissions/${id}/media/${m.sha256}`;
    expect(m.chunks.map((x) => x.length)).toEqual([0, 1, 2].map((n) => expectedChunkBytes(m.size, n)));

    expect((await c.get(base + "/status")).body).toEqual({ received: [], header: false, chunks: 3, complete: false });
    expect((await c.putRaw(base + "/header", m.header)).status).toBe(200);
    expect((await c.putRaw(base + "/chunks/0", m.chunks[0]!)).status).toBe(200);
    // "connection drops"; the client asks what arrived and resumes from there
    const status = await c.get(base + "/status");
    expect(status.body).toEqual({ received: [0], header: true, chunks: 3, complete: false });
    const early = await c.post(base + "/complete");
    expect(early.status).toBe(409);
    expect(early.body.message).toBe("missing chunks: 1, 2");
    expect((await c.post(`/submissions/${id}/submit`)).body.error).toBe("media_incomplete");
    expect((await c.putRaw(base + "/chunks/2", m.chunks[2]!)).status).toBe(200);
    // re-uploading a chunk is idempotent
    expect((await c.putRaw(base + "/chunks/2", m.chunks[2]!)).status).toBe(200);
    expect((await c.putRaw(base + "/chunks/1", m.chunks[1]!)).status).toBe(200);
    const done = await c.post(base + "/complete");
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ sha256: m.sha256, complete: true });
    expect((await c.get(base + "/status")).body).toEqual({
      received: [0, 1, 2],
      header: true,
      chunks: 3,
      complete: true,
    });

    // re-uploading after completion requires completing again
    expect((await c.putRaw(base + "/chunks/1", m.chunks[1]!)).status).toBe(200);
    expect((await c.get(base + "/status")).body.complete).toBe(false);
    expect((await c.post(base + "/complete")).status).toBe(200);

    // on disk: exactly the documented layout
    const files = (await readdir(join(env.config.stagingDir, id, m.sha256))).sort();
    expect(files).toEqual(["0", "1", "2", "header"]);

    expect((await c.post(`/submissions/${id}/submit`)).status).toBe(200);

    // a moderator downloads and decrypts with their own wrap
    const mod = env.client(env.mod1);
    const view = await mod.get(`/submissions/${id}?x25519=${env.mod1.x.publicKey}`);
    const key = await unwrapKey(view.body.wrappedKey, env.mod1.x);
    const header = await mod.get(base + "/header");
    expect(header.headers["content-type"]).toBe("application/octet-stream");
    const chunks = [];
    for (let n = 0; n < 3; n++) chunks.push(new Uint8Array((await mod.get(`${base}/chunks/${n}`)).raw));
    const plain = await decryptBytes({ header: new Uint8Array(header.raw), chunks }, key);
    expect(sha256Hex(plain)).toBe(m.sha256);
    expect(Buffer.compare(Buffer.from(plain), Buffer.from(m.plaintext))).toBe(0); // (deep-equal is slow on MiBs)
    expect((await mod.get(`${base}/chunks/3`)).status).toBe(404);
    expect((await mod.get(base + "/status")).status).toBe(200);
  });

  it("enforces exact chunk and header sizes and the chunk range", async () => {
    const s = await draftSubmission(env, undefined, { images: [CHUNK_SIZE + 10] });
    const m = s.draft.media[0]!;
    const base = `/submissions/${s.id}/media/${m.sha256}`;
    const h = await s.c.putRaw(base + "/header", new Uint8Array(23));
    expect(h.status).toBe(400);
    expect(h.body.error).toBe("invalid_header");
    const short = await s.c.putRaw(base + "/chunks/0", m.chunks[0]!.subarray(1));
    expect(short.body.error).toBe("invalid_chunk_size");
    const lastWrong = await s.c.putRaw(base + "/chunks/1", m.chunks[0]!);
    expect(lastWrong.body.error).toBe("invalid_chunk_size");
    const range = await s.c.putRaw(base + "/chunks/2", m.chunks[1]!);
    expect(range.body.error).toBe("chunk_out_of_range");
    const json = await s.c.put(base + "/chunks/0", { not: "bytes" });
    expect(json.status).toBe(415);
  });

  it("is path-traversal proof", async () => {
    const s = await draftSubmission(env);
    const m = s.draft.media[0]!;
    const bytes = m.chunks[0]!;
    const attempts = [
      `/submissions/${s.id}/media/..%2F..%2F..%2Fetc/chunks/0`,
      `/submissions/${s.id}/media/${m.sha256}/chunks/..%2F..%2Fx`,
      `/submissions/${s.id}/media/${m.sha256}/chunks/-1`,
      `/submissions/${s.id}/media/${m.sha256}/chunks/1.5`,
      `/submissions/${s.id}/media/${m.sha256}/chunks/01`,
      `/submissions/${s.id}/media/${m.sha256}/chunks/1e3`,
      `/submissions/${s.id}/media/${m.sha256.toUpperCase()}/chunks/0`,
      `/submissions/..%2F..%2Ftmp/media/${m.sha256}/chunks/0`,
    ];
    for (const path of attempts) {
      const r = await s.c.putRaw(path, bytes);
      expect([400, 404], path).toContain(r.status);
    }
    // an unlisted (but well-formed) sha is 404
    expect((await s.c.putRaw(`/submissions/${s.id}/media/${"e".repeat(64)}/chunks/0`, bytes)).status).toBe(404);
    const files = await readdir(env.config.stagingDir, { recursive: true });
    expect(files.every((f) => f.startsWith(s.id) || /^[0-9a-f-]{36}/.test(f))).toBe(true);
  });

  it("re-wraps keys for a newly added moderator", async () => {
    const s = await submittedSubmission(env);
    const mod3 = await newActor();
    env.setModerators([{ actor: env.mod1 }, { actor: env.mod2 }, { actor: mod3 }]);
    try {
      const need = await env.client(env.mod1).get("/rewrap-needed");
      const item = need.body.find((x: { id: string }) => x.id === s.id);
      expect(item.missing).toEqual([mod3.x.publicKey]);
      // mod3 can't read it yet
      const before = await env.client(mod3).get(`/submissions/${s.id}?x25519=${mod3.x.publicKey}`);
      expect(before.body.wrappedKey).toBeNull();
      // mod1 unwraps its own copy and wraps for mod3
      const key = await unwrapKey(item.wrappedKey, env.mod1.x);
      const bogus = await env.client(env.mod1).post(`/submissions/${s.id}/keys`, {
        wrappedKeys: { [env.publisher.x.publicKey]: await wrapKey(key, env.publisher.x.publicKey) },
      });
      expect(bogus.body.error).toBe("unknown_recipient");
      const add = await env.client(env.mod1).post(`/submissions/${s.id}/keys`, {
        wrappedKeys: {
          [mod3.x.publicKey]: await wrapKey(key, mod3.x.publicKey),
          [env.mod2.x.publicKey]: await wrapKey(key, env.mod2.x.publicKey),
        },
      });
      expect(add.body.added).toEqual([mod3.x.publicKey]); // mod2's existing wrap is never replaced
      const after = await env.client(mod3).get(`/submissions/${s.id}?x25519=${mod3.x.publicKey}`);
      expect(Buffer.from(await unwrapKey(after.body.wrappedKey, mod3.x))).toEqual(Buffer.from(s.draft.contentKey));
      expect((await env.client(env.mod1).get("/rewrap-needed")).body.some((x: { id: string }) => x.id === s.id)).toBe(
        false,
      );
      // new submissions must now include mod3
      const kp = await newContributor(env);
      const d = await makeDraft(env, kp, {
        recipients: [env.owner.x.publicKey, env.mod1.x.publicKey, env.mod2.x.publicKey],
      });
      expect((await env.client(kp).post("/submissions", d.request)).body.error).toBe("missing_wrapped_keys");
    } finally {
      env.setModerators([{ actor: env.mod1 }, { actor: env.mod2 }]);
    }
  });

  it("GET /config lists the keys a contributor must wrap for", async () => {
    const r = await env.app.inject({ method: "GET", url: "/config" });
    const body = r.json();
    expect(body.ownerPubkey).toBe(env.owner.kp.pubkey);
    expect(body.ownerX25519).toBe(env.owner.x.publicKey);
    expect(body.publisher).toEqual({ pubkey: env.publisher.kp.pubkey, x25519: env.publisher.x.publicKey });
    expect(body.moderators).toEqual([
      { pubkey: env.mod1.kp.pubkey, x25519: env.mod1.x.publicKey },
      { pubkey: env.mod2.kp.pubkey, x25519: env.mod2.x.publicKey },
    ]);
    expect(body.limits).toMatchObject({ chunkSize: CHUNK_SIZE, maxBlocks: 100, maxImageBytes: 20 * 1024 * 1024 });
    expect(body.relays).toEqual([{ url: "ws://127.0.0.1:1", operator: "own" }]);
  });
});
