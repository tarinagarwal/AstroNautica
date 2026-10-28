import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvePayload, auditEvent, inReviewSubmission, newContributor, setup, type TestEnv } from "./helpers.js";

describe("logging never contains IP addresses", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("logs requests, errors and server failures without addresses, headers or ids", async () => {
    // A full flow, plus failures of every kind, from several "remote addresses".
    const s = await inReviewSubmission(env);
    const { payload } = await approvePayload(env, env.mod1, s);
    await env.client(env.mod1).post(`/submissions/${s.id}/approve`, payload);
    await env.client(env.mod1).get("/queue", { noAuth: true });
    await env.client(await newContributor(env)).post("/submissions", { bad: true });
    await env.client(env.mod1).post("/moderation/unlist", {
      storyId: s.draft.storyId,
      auditEvent: auditEvent(env.mod1.kp, "unlist", { storyId: s.draft.storyId }),
    });
    for (const remoteAddress of ["203.0.113.7", "2001:db8::1", "10.1.2.3"]) {
      await env.app.inject({
        method: "GET",
        url: "/health",
        remoteAddress,
        headers: { "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.10" },
      });
      await env.app.inject({ method: "GET", url: "/nope", remoteAddress });
    }
    // a 500: break the database connection pool for one request
    const original = env.pool.query.bind(env.pool);
    (env.pool as { query: unknown }).query = () => Promise.reject(new Error("boom"));
    const r = await env.app.inject({
      method: "GET",
      url: "/contributors",
      remoteAddress: "203.0.113.8",
      headers: { authorization: env.client(env.mod1).lastAuth },
    });
    (env.pool as { query: unknown }).query = original;
    expect([401, 500]).toContain(r.statusCode);
    const fail = await env.client(env.mod1).get("/queue");
    expect(fail.status).toBe(200);
    (env.pool as { query: unknown }).query = () =>
      Promise.reject(new Error("connect ECONNREFUSED 10.9.8.7:5432 via ::ffff:10.9.8.7 and fe80::1:2:3"));
    const err = await env.client(env.mod1).get("/contributors");
    (env.pool as { query: unknown }).query = original;
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ error: "internal", message: "internal server error" });

    const text = env.logs.text;
    expect(env.logs.lines.length).toBeGreaterThan(20);
    expect(text).toContain('"route":"/submissions/:id/approve"');
    expect(text).toContain("request failed");
    for (const forbidden of [
      "127.0.0.1",
      "203.0.113",
      "2001:db8",
      "10.1.2.3",
      "10.9.8.7",
      "fe80::",
      "198.51.100",
      "remoteAddress",
      "remotePort",
      '"ip"',
      "x-forwarded-for",
      "authorization",
      "Nostr ",
      'hostname":"',
      s.id,
      s.contributor.pubkey,
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});

describe("RelayAuditForwarder", () => {
  it("forwards to the own relays and logs failures without addresses", async () => {
    const { RelayAuditForwarder } = await import("../src/forwarder.js");
    const { auditEvent } = await import("./helpers.js");
    const { generateKeyPair } = await import("@azaadawaaz/core");
    const sent: string[][] = [];
    const warnings: object[] = [];
    const f = new RelayAuditForwarder(
      {
        publish: async (relays) => {
          sent.push(relays);
          return relays.map((relay, i) => ({ relay, ok: i === 0, message: i === 0 ? "" : "connection refused" }));
        },
      },
      () => ["wss://relay.azaadawaaz.example", "ws://192.0.2.5:7777", "ws://[2001:db8::5]:7777"],
      { warn: (o) => warnings.push(o) },
    );
    f.forward(auditEvent(generateKeyPair(), "hide", { e: "e".repeat(64) }));
    await f.flush();
    expect(sent).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    const text = JSON.stringify(warnings);
    expect(text).toContain("[addr]");
    expect(text).not.toContain("192.0.2.5");
    expect(text).not.toContain("2001:db8");
  });
});
