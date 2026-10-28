/**
 * Test harness: a fresh Postgres database per test file (on the test container), a server built with injected
 * lists, a log capture, a recording audit forwarder, and real keys and crypto from @azaadawaaz/core.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KIND_AUDIT,
  createInvite,
  createListEvent,
  createRedemption,
  encryptBytes,
  encryptJson,
  generateEncryptionKeyPair,
  generateKeyPair,
  decryptJson,
  newContentKey,
  signApproval,
  unwrapKey,
  wrapKey,
  wrapKeyFor,
  type EncryptionKeyPair,
  type Event,
  type KeyPair,
} from "@azaadawaaz/core";
import { STORY_SCHEMA, approvalBodySha256, sha256Hex, uuidv7, type ApprovalBody } from "@azaadawaaz/schema";
import type { FastifyInstance } from "fastify";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent } from "nostr-tools/pure";
import pg from "pg";
import type { AuditForwarder } from "../src/audit.js";
import type { Config } from "../src/config.js";
import { createPool, type Pool } from "../src/db.js";
import { ListsService } from "../src/lists.js";
import { runMigrations } from "../src/migrate.js";
import { buildServer } from "../src/server.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/azaad_test";
export const PUBLIC_URL = "http://api.test:8787";

export interface Actor {
  kp: KeyPair;
  x: EncryptionKeyPair;
}

export async function newActor(): Promise<Actor> {
  return { kp: generateKeyPair(), x: await generateEncryptionKeyPair() };
}

/** Collects every log line the server writes. */
export class LogCapture {
  readonly lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("");
  }
}

export class RecordingForwarder implements AuditForwarder {
  readonly events: Event[] = [];
  forward(e: Event): void {
    this.events.push(e);
  }
}

async function createDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `api_t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(TEST_DB_URL);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: TEST_DB_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export function testConfig(over: Partial<Config> & { stagingDir: string; databaseUrl: string; ownerPubkey: string }): Config {
  return {
    port: 8787,
    host: "127.0.0.1",
    publicUrls: [PUBLIC_URL],
    basePath: "",
    relays: ["ws://127.0.0.1:1"],
    allowedOrigins: ["http://localhost:5173"],
    claimMinutes: 30,
    unlistPerHour: 5,
    submissionsPerHour: 30,
    rejectedRetentionDays: 30,
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 2 * 1024 ** 3,
    maxBlocks: 100,
    maxJsonBytes: 8 * 1024 * 1024,
    listsRefreshSeconds: 30,
    cleanupIntervalMinutes: 60,
    autoMigrate: false,
    logLevel: "info",
    ...over,
  };
}

export interface TestEnv {
  app: FastifyInstance;
  pool: Pool;
  lists: ListsService;
  config: Config;
  logs: LogCapture;
  forwarded: RecordingForwarder;
  owner: Actor;
  publisher: Actor;
  mod1: Actor;
  mod2: Actor;
  client(actor: Actor | KeyPair): TestClient;
  /** Re-sign and feed the owner's moderator list (e.g. to add or remove moderators). */
  setModerators(mods: { actor: Actor; from?: number; until?: number }[]): void;
  close(): Promise<void>;
}

export async function setup(over: Partial<Config> = {}): Promise<TestEnv> {
  const db = await createDatabase();
  const pool = createPool(db.url, 10);
  await runMigrations(pool);
  const stagingDir = await mkdtemp(join(tmpdir(), "api-staging-"));
  const [owner, publisher, mod1, mod2] = await Promise.all([newActor(), newActor(), newActor(), newActor()]);
  const config = testConfig({ stagingDir, databaseUrl: db.url, ownerPubkey: owner.kp.pubkey, ...over });
  const lists = new ListsService({ ownerPubkey: owner.kp.pubkey, relays: config.relays });
  const from = Math.floor(Date.now() / 1000) - 3600;
  let listClock = from;
  const setModerators: TestEnv["setModerators"] = (mods) => {
    listClock = Math.max(listClock + 1, Math.floor(Date.now() / 1000) - 600);
    lists.feed([
      createListEvent(
        "moderators",
        mods.map((m) => ({
          pubkey: m.actor.kp.pubkey,
          x25519: m.actor.x.publicKey,
          from: m.from ?? from,
          ...(m.until !== undefined ? { until: m.until } : {}),
        })),
        owner.kp.secretKey,
        listClock,
      ),
    ]);
  };
  lists.feed([
    createListEvent(
      "service-keys",
      [
        { role: "owner", pubkey: owner.kp.pubkey, x25519: owner.x.publicKey, from },
        { role: "publisher", pubkey: publisher.kp.pubkey, x25519: publisher.x.publicKey, from },
      ],
      owner.kp.secretKey,
      from,
    ),
    createListEvent("relays", [{ url: "ws://127.0.0.1:1", operator: "own" }], owner.kp.secretKey, from),
  ]);
  setModerators([{ actor: mod1 }, { actor: mod2 }]);
  const logs = new LogCapture();
  const forwarded = new RecordingForwarder();
  const app = await buildServer({ config, pool, lists, forwarder: forwarded, logger: { stream: logs, level: "info" } });
  const env: TestEnv = {
    app,
    pool,
    lists,
    config,
    logs,
    forwarded,
    owner,
    publisher,
    mod1,
    mod2,
    client: (a) => new TestClient(app, "kp" in a ? a.kp : a),
    setModerators,
    close: async () => {
      await app.close();
      await pool.end();
      await db.drop();
      await rm(stagingDir, { recursive: true, force: true });
    },
  };
  return env;
}

export interface Res<T = any> {
  status: number;
  body: T;
  raw: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}

export interface ReqOpts {
  json?: unknown;
  raw?: Uint8Array;
  /** Skip the Authorization header. */
  noAuth?: boolean;
  /** Override what the auth event signs. */
  authUrl?: string;
  authMethod?: string;
  authBody?: string | Uint8Array;
  authCreatedAt?: number;
  /** Send this exact Authorization header. */
  header?: string;
  contentType?: string;
}

/**
 * NIP-98 header like `core.createAuthHeader`, plus a random ["nonce"] tag so that two identical requests within the
 * same second are distinct events (the server rightly rejects a repeated event id as a replay).
 */
export function authHeader(
  url: string,
  method: string,
  secretKey: Uint8Array,
  body?: Uint8Array | string,
  createdAt = Math.floor(Date.now() / 1000),
): string {
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
    ["nonce", randomBytes(8).toString("hex")],
  ];
  if (body !== undefined && body.length > 0) tags.push(["payload", sha256Hex(body)]);
  const e = finalizeEvent({ kind: 27235, created_at: createdAt, tags, content: "" }, secretKey);
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString("base64")}`;
}

/** A client acting as one key: signs every request with NIP-98 exactly like the web app does. */
export class TestClient {
  lastAuth = "";
  constructor(
    readonly app: FastifyInstance,
    readonly kp: KeyPair,
  ) {}

  get pubkey(): string {
    return this.kp.pubkey;
  }

  async req<T = any>(method: string, path: string, o: ReqOpts = {}): Promise<Res<T>> {
    const payload: string | Buffer | undefined =
      o.json !== undefined ? JSON.stringify(o.json) : o.raw ? Buffer.from(o.raw) : undefined;
    const headers: Record<string, string> = {};
    if (payload !== undefined)
      headers["content-type"] = o.contentType ?? (o.json !== undefined ? "application/json" : "application/octet-stream");
    if (!o.noAuth) {
      const auth =
        o.header ??
        authHeader(
          o.authUrl ?? PUBLIC_URL + path,
          o.authMethod ?? method,
          this.kp.secretKey,
          o.authBody ?? (typeof payload === "string" ? payload : payload ? new Uint8Array(payload) : undefined),
          o.authCreatedAt,
        );
      headers.authorization = auth;
      this.lastAuth = auth;
    }
    const r = await this.app.inject({ method: method as "GET", url: path, headers, payload });
    let body: any = undefined;
    const ct = String(r.headers["content-type"] ?? "");
    if (ct.includes("application/json")) body = r.json();
    return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers };
  }

  get<T = any>(path: string, o?: ReqOpts) {
    return this.req<T>("GET", path, o);
  }
  post<T = any>(path: string, json?: unknown, o?: ReqOpts) {
    return this.req<T>("POST", path, { ...o, json });
  }
  put<T = any>(path: string, json?: unknown, o?: ReqOpts) {
    return this.req<T>("PUT", path, { ...o, json });
  }
  putRaw<T = any>(path: string, raw: Uint8Array, o?: ReqOpts) {
    return this.req<T>("PUT", path, { ...o, raw });
  }
}

// ---- Realistic actors and payloads ----

/** Owner issues an invite; a new contributor key redeems it. Returns the contributor's key. */
export async function newContributor(env: TestEnv): Promise<KeyPair> {
  const kp = generateKeyPair();
  const invite = createInvite(env.owner.kp.secretKey, { note: "test" });
  const r = await env.client(kp).post("/invites/redeem", { redemption: createRedemption(invite.event, kp.secretKey) }, {
    noAuth: true,
  });
  if (r.status !== 201) throw new Error(`redeem failed: ${r.status} ${JSON.stringify(r.body)}`);
  return kp;
}

export interface MediaFile {
  sha256: string;
  size: number;
  mime: string;
  kind: "image" | "video";
  plaintext: Uint8Array;
  header: Uint8Array;
  chunks: Uint8Array[];
}

export interface Draft {
  storyId: string;
  version: number;
  contentKey: Uint8Array;
  body: ApprovalBody;
  media: MediaFile[];
  request: {
    storyId: string;
    version: number;
    supersedes: string | null;
    bodyCiphertext: string;
    wrappedKeys: Record<string, string>;
    media: { sha256: string; size: number; mime: string; kind: "image" | "video"; chunks: number }[];
  };
}

/** Recipients a contributor client wraps for: the owner and every active moderator, from GET /config. */
export function recipients(env: TestEnv): string[] {
  return env.lists.requiredRecipients();
}

export async function makeDraft(
  env: TestEnv,
  contributor: KeyPair,
  opts: {
    images?: number[];
    storyId?: string;
    version?: number;
    supersedes?: string | null;
    title?: string;
    recipients?: string[];
    contentKey?: Uint8Array;
  } = {},
): Promise<Draft> {
  const storyId = opts.storyId ?? uuidv7();
  const version = opts.version ?? 1;
  const contentKey = opts.contentKey ?? (await newContentKey());
  const media: MediaFile[] = [];
  for (const size of opts.images ?? [1000]) {
    const plaintext = new Uint8Array(randomBytes(size));
    const blob = await encryptBytes(plaintext, contentKey);
    media.push({
      sha256: sha256Hex(plaintext),
      size,
      mime: "image/jpeg",
      kind: "image",
      plaintext,
      header: blob.header,
      chunks: blob.chunks,
    });
  }
  const body: ApprovalBody = {
    schema: STORY_SCHEMA,
    id: storyId,
    version,
    supersedes: opts.supersedes ?? null,
    language: "en",
    title: { en: opts.title ?? "Floods in the valley" },
    summary: { en: "What we saw." },
    tags: ["floods"],
    contributor: { pubkey: contributor.npub, displayName: "AzaadAwaaz contributor" },
    blocks: [
      { type: "text", markdown: { en: "## Morning\nWater rose." } },
      ...(media.length ? [{ type: "image" as const, items: media.map((m) => ({ sha256: m.sha256 })) }] : []),
    ],
  };
  return {
    storyId,
    version,
    contentKey,
    body,
    media,
    request: {
      storyId,
      version,
      supersedes: opts.supersedes ?? null,
      bodyCiphertext: await encryptJson(body, contentKey),
      wrappedKeys: await wrapKeyFor(contentKey, opts.recipients ?? recipients(env)),
      media: media.map((m) => ({ sha256: m.sha256, size: m.size, mime: m.mime, kind: m.kind, chunks: m.chunks.length })),
    },
  };
}

export async function uploadMedia(c: TestClient, id: string, m: MediaFile): Promise<void> {
  const base = `/submissions/${id}/media/${m.sha256}`;
  const h = await c.putRaw(base + "/header", m.header);
  if (h.status !== 200) throw new Error(`header upload: ${h.status} ${JSON.stringify(h.body)}`);
  for (let n = 0; n < m.chunks.length; n++) {
    const r = await c.putRaw(`${base}/chunks/${n}`, m.chunks[n]!);
    if (r.status !== 200) throw new Error(`chunk upload: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const done = await c.post(base + "/complete");
  if (done.status !== 200) throw new Error(`complete: ${done.status} ${JSON.stringify(done.body)}`);
}

export interface Sub {
  id: string;
  draft: Draft;
  contributor: KeyPair;
  c: TestClient;
}

/** Create a submission with media uploaded (state draft). */
export async function draftSubmission(env: TestEnv, contributor?: KeyPair, opts: Parameters<typeof makeDraft>[2] = {}) {
  const kp = contributor ?? (await newContributor(env));
  const c = env.client(kp);
  const draft = await makeDraft(env, kp, opts);
  const r = await c.post("/submissions", draft.request);
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  for (const m of draft.media) await uploadMedia(c, r.body.id, m);
  return { id: r.body.id as string, draft, contributor: kp, c } satisfies Sub;
}

export async function submittedSubmission(env: TestEnv, contributor?: KeyPair, opts?: Parameters<typeof makeDraft>[2]) {
  const s = await draftSubmission(env, contributor, opts);
  const r = await s.c.post(`/submissions/${s.id}/submit`);
  if (r.status !== 200) throw new Error(`submit: ${r.status} ${JSON.stringify(r.body)}`);
  return s;
}

export async function inReviewSubmission(env: TestEnv, by: Actor = env.mod1) {
  const s = await submittedSubmission(env);
  const r = await env.client(by).post(`/submissions/${s.id}/claim`);
  if (r.status !== 200) throw new Error(`claim: ${r.status} ${JSON.stringify(r.body)}`);
  return s;
}

/** A signed audit event (kind 9737) as a moderator client builds it. */
export function auditEvent(
  signer: KeyPair,
  action: string,
  t: { submissionId?: string; storyId?: string; p?: string; e?: string; extra?: string[][] } = {},
  createdAt = Math.floor(Date.now() / 1000),
): Event {
  const tags: string[][] = [["action", action]];
  if (t.submissionId) tags.push(["s", sha256Hex(t.submissionId)]);
  if (t.storyId) tags.push(["story", t.storyId]);
  if (t.p) tags.push(["p", t.p]);
  if (t.e) tags.push(["e", t.e]);
  tags.push(...(t.extra ?? []));
  return finalizeEvent({ kind: KIND_AUDIT, created_at: createdAt, tags, content: "" }, signer.secretKey);
}

/** Feedback text NIP-44-encrypted from the moderator to the contributor. */
export function feedbackFor(mod: KeyPair, contributorPubkey: string, text: string): string {
  return nip44Encrypt(text, getConversationKey(mod.secretKey, contributorPubkey));
}

export function nowIso(offsetSec = 0): string {
  return new Date(Date.now() + offsetSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * What a moderator client sends to approve: it fetches its own wrap, decrypts the body (proving the round trip),
 * signs the approval body, re-wraps the content key for the publisher and signs the audit event.
 */
export async function approvePayload(env: TestEnv, mod: Actor, s: Sub, approvedAt?: string) {
  const r = await env.client(mod).get(`/submissions/${s.id}?x25519=${mod.x.publicKey}`);
  if (r.status !== 200 || !r.body.wrappedKey) throw new Error(`fetch for approval: ${r.status} ${JSON.stringify(r.body)}`);
  const key = await unwrapKey(r.body.wrappedKey, mod.x);
  const body = await decryptJson<ApprovalBody>(r.body.bodyCiphertext, key);
  return {
    body,
    payload: {
      approval: signApproval(body, mod.kp.secretKey, approvedAt),
      approvalBodySha256: approvalBodySha256(body),
      publisherWrappedKey: await wrapKey(key, env.publisher.x.publicKey),
      auditEvent: auditEvent(mod.kp, "approve", { submissionId: s.id, storyId: s.draft.storyId }),
    },
  };
}

export { nip44Encrypt };
