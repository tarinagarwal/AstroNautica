import { createHash } from "node:crypto";
import {
  KIND_AUDIT,
  buildEffectiveLists,
  createListEvent,
  encryptBytes,
  encryptJson,
  generateEncryptionKeyPair,
  hexToNpub,
  newContentKey,
  unwrapKey,
  verifyApprovalSignature,
  verifyAuthHeader,
  wrapKey,
  type EncryptionKeyPair,
} from "@azaadawaaz/core";
import { approvalBodySha256, approvalMessageHash, sha256Hex, uuidv7, type ApprovalBody } from "@azaadawaaz/schema";
import { Api, type SubmissionDetail } from "../../api/client";
import { signerFromSecret } from "../../api/nip98";
import { normalizeConfig } from "../../config";
import { decryptFeedback } from "../../contributor/submissions";
import { AppData } from "../../data/appData";
import { GatewayClient } from "../../data/gateways";
import { JsonStore } from "../../platform/kv";
import { joinPath } from "../../platform/types";
import { fakeHttp, nodeFs } from "../../test/nodePlatform";
import { MemoryPool, NOW, contributor, modA, owner, ownerLists, publisher } from "../../test/fixtures";
import { concatBytes } from "../../util/bytes";
import { changeList, hideComment, muteKey, syncContributors, unlistStory } from "../actions";
import { previewMedia, PreviewIntegrityError } from "../preview";
import {
  approve,
  bodyProblems,
  claim,
  identityFrom,
  openSubmission,
  publisherKey,
  rejectSubmission,
  requestChanges,
  rewrapPending,
} from "../review";

const API = "https://api.example";
let modX: EncryptionKeyPair;
let pubX: EncryptionKeyPair;
let newModX: EncryptionKeyPair;

const image = Uint8Array.from({ length: 3000 }, (_, i) => (i * 5) & 255);
const imageSha = createHash("sha256").update(image).digest("hex");

function body(): ApprovalBody {
  return {
    schema: "azaadawaaz/story@1",
    id: storyId,
    version: 1,
    supersedes: null,
    language: "en",
    title: { en: "Title" },
    summary: { en: "Summary" },
    tags: [],
    contributor: { pubkey: contributor.npub, displayName: "Pen" },
    blocks: [
      { type: "text", markdown: { en: "Text" } },
      { type: "image", items: [{ sha256: imageSha }] },
    ],
  };
}
const storyId = uuidv7();

beforeAll(async () => {
  modX = await generateEncryptionKeyPair();
  pubX = await generateEncryptionKeyPair();
  newModX = await generateEncryptionKeyPair();
});

async function server() {
  const key = await newContentKey();
  const blob = await encryptBytes(image, key, 1000);
  const detail: SubmissionDetail = {
    id: "11111111-1111-4111-8111-111111111111",
    storyId,
    version: 1,
    supersedes: null,
    contributor: contributor.pubkey,
    state: "submitted",
    bodyCiphertext: await encryptJson(body(), key),
    wrappedKey: await wrapKey(key, modX.publicKey),
    media: [
      {
        sha256: imageSha,
        size: image.length,
        mime: "image/jpeg",
        kind: "image",
        chunks: blob.chunks.length,
        complete: true,
      },
    ],
  };
  const calls: { path: string; body: any }[] = [];
  const http = fakeHttp((req) => {
    const auth = verifyAuthHeader(req.headers.authorization, req.url, req.method, req.body);
    if (!auth.ok) return { status: 401, body: JSON.stringify({ error: "unauthorized", message: auth.error }) };
    const u = new URL(req.url);
    const b = req.body?.length ? JSON.parse(new TextDecoder().decode(req.body)) : undefined;
    calls.push({ path: u.pathname, body: b });
    if (u.pathname === `/submissions/${detail.id}`)
      return {
        body: JSON.stringify(
          u.searchParams.get("x25519") === modX.publicKey ? detail : { ...detail, wrappedKey: null },
        ),
      };
    if (u.pathname.endsWith("/header")) return { body: blob.header };
    const m = u.pathname.match(/\/chunks\/(\d+)$/);
    if (m) return { body: blob.chunks[Number(m[1])]! };
    if (u.pathname === "/rewrap-needed")
      return {
        body: JSON.stringify([
          { id: detail.id, missing: [newModX.publicKey, "99".repeat(32)], wrappedKey: detail.wrappedKey },
        ]),
      };
    if (u.pathname === "/contributors")
      return {
        body: JSON.stringify([
          { pubkey: contributor.pubkey, redeemedAt: "", revokedAt: null },
          { pubkey: owner.pubkey, redeemedAt: "", revokedAt: "x" },
        ]),
      };
    if (u.pathname.endsWith("/keys")) return { body: JSON.stringify({ added: Object.keys(b.wrappedKeys) }) };
    return { body: JSON.stringify({ ok: true }) };
  });
  return { api: new Api(API, http, signerFromSecret(modA.secretKey)), http, detail, calls, key, blob };
}

const lists = () =>
  buildEffectiveLists(owner.pubkey, [
    createListEvent(
      "service-keys",
      [{ role: "publisher", pubkey: publisher.pubkey, x25519: pubX?.publicKey ?? "55".repeat(32), from: NOW - 1000 }],
      owner.secretKey,
      NOW - 10,
    ),
  ]);

describe("moderator review", () => {
  it("opens a submission with the moderator's X25519 key and checks it", async () => {
    const { api } = await server();
    const me = identityFrom(modA.secretKey, modX);
    const opened = await openSubmission(api, "11111111-1111-4111-8111-111111111111", me);
    expect(opened.body).toEqual(body());
    expect(opened.problems).toEqual([]);
    const other = await generateEncryptionKeyPair();
    await expect(
      openSubmission(api, "11111111-1111-4111-8111-111111111111", identityFrom(modA.secretKey, other)),
    ).rejects.toThrow(/no key wrapped/);
  });

  it("spots a body that doesn't match the submission", async () => {
    const { detail } = await server();
    expect(bodyProblems({ ...body(), id: uuidv7() }, detail)).toContain("story id differs from the submission");
    expect(
      bodyProblems({ ...body(), contributor: { pubkey: hexToNpub(owner.pubkey), displayName: "x" } }, detail),
    ).toContain("contributor key differs from the submitter");
    expect(
      bodyProblems({ ...body(), blocks: [{ type: "image", items: [{ sha256: "e".repeat(64) }] }] }, detail)[0],
    ).toMatch(/was not uploaded/);
  });

  it("approves: signs the approval body, re-wraps for the publisher only, sends a signed audit event", async () => {
    const { api, calls, key } = await server();
    const me = identityFrom(modA.secretKey, modX);
    const opened = await openSubmission(api, "11111111-1111-4111-8111-111111111111", me);
    const approval = await approve(api, opened, me, lists());
    const sent = calls.find((c) => c.path.endsWith("/approve"))!.body;
    expect(verifyApprovalSignature(body(), approval)).toBe(true);
    expect(sent.approvalBodySha256).toBe(approvalBodySha256(body()));
    expect(approvalMessageHash(sent.approvalBodySha256, approval.approvedAt)).toMatch(/^[0-9a-f]{64}$/);
    expect(await unwrapKey(sent.publisherWrappedKey, pubX)).toEqual(key);
    expect(sent.auditEvent.kind).toBe(KIND_AUDIT);
    expect(sent.auditEvent.tags).toEqual(
      expect.arrayContaining([
        ["action", "approve"],
        ["s", sha256Hex(opened.detail.id)],
        ["story", storyId],
      ]),
    );
    await expect(approve(api, { ...opened, problems: ["x"] }, me, lists())).rejects.toThrow(/cannot approve/);
  });

  it("refuses a server that names a different publisher", () => {
    expect(() =>
      publisherKey(lists(), { publisher: { pubkey: modA.pubkey, x25519: "00".repeat(32) } } as never),
    ).toThrow(/publisher/);
    expect(() => publisherKey(buildEffectiveLists(owner.pubkey, []))).toThrow(/no publisher/);
  });

  it("rejects and requests changes with feedback only the contributor can read, and no story id", async () => {
    const { api, calls, detail } = await server();
    const me = identityFrom(modA.secretKey, modX);
    await rejectSubmission(api, detail, me, "Off topic");
    await requestChanges(api, detail, me, "Blur faces");
    await claim(api, detail.id, me);
    const rej = calls.find((c) => c.path.endsWith("/reject"))!.body;
    expect(
      decryptFeedback({ at: "", moderator: modA.pubkey, kind: "reject", nip44: rej.feedback }, contributor.secretKey)
        .text,
    ).toBe("Off topic");
    expect(rej.auditEvent.tags.some((t: string[]) => t[0] === "story")).toBe(false);
    expect(calls.find((c) => c.path.endsWith("/request-changes"))!.body.auditEvent.tags).toContainEqual([
      "action",
      "request_changes",
    ]);
    expect(calls.find((c) => c.path.endsWith("/claim"))!.body.auditEvent.tags).toContainEqual(["action", "claim"]);
    await expect(rejectSubmission(api, detail, me, " ")).rejects.toThrow(/reason/);
  });

  it("re-wraps keys only for keys on the signed lists", async () => {
    const { api, calls } = await server();
    const r = await rewrapPending(api, identityFrom(modA.secretKey, modX), new Set([newModX.publicKey]));
    expect(r).toEqual([{ id: "11111111-1111-4111-8111-111111111111", added: 1 }]);
    const wraps = calls.find((c) => c.path.endsWith("/keys"))!.body.wrappedKeys;
    expect(Object.keys(wraps)).toEqual([newModX.publicKey]);
    expect((await unwrapKey(wraps[newModX.publicKey], newModX)).length).toBe(32);
  });

  it("previews media only after the decrypted bytes match their hash", async () => {
    const { api, http, detail, key } = await server();
    const fs = nodeFs();
    const signer = signerFromSecret(modA.secretKey);
    const args = {
      api,
      http,
      fs,
      signer,
      decryptor: { decryptChunks: async () => ({ sha256: "", size: 0 }) },
      submissionId: detail.id,
      media: detail.media[0]!,
      contentKey: key,
      workDir: joinPath(fs.paths.cache, "r"),
    };
    const path = await previewMedia(args);
    expect(concatBytes([await fs.readBytes(path)])).toEqual(image);
    await expect(
      previewMedia({
        ...args,
        media: { ...detail.media[0]!, sha256: "f".repeat(64) },
        workDir: joinPath(fs.paths.cache, "r2"),
      }),
    ).rejects.toBeInstanceOf(PreviewIntegrityError);
  });
});

describe("moderator list actions", () => {
  function app() {
    const fs = nodeFs();
    const pool = new MemoryPool(ownerLists());
    const a = new AppData(
      normalizeConfig({ ownerPubkey: owner.pubkey, bootstrapRelays: ["wss://r.example"] }),
      pool,
      new GatewayClient(fakeHttp(() => ({ status: 404 }))),
      new JsonStore(fs, "d"),
      fs,
    );
    return { a, pool };
  }

  it("hides, mutes and unlists through the moderator's own signed lists", async () => {
    const { a, pool } = app();
    await a.refresh();
    const { api, calls } = await server();
    const h = await hideComment(a, api, modA.secretKey, modA.pubkey, "c".repeat(64));
    expect(h.auditError).toBeUndefined();
    expect(a.lists!.hidden.has("c".repeat(64))).toBe(true);
    await muteKey(a, api, modA.secretKey, modA.pubkey, "d".repeat(64));
    expect(a.lists!.muted.has("d".repeat(64))).toBe(true);
    const u = await unlistStory(a, api, modA.secretKey, modA.pubkey, storyId);
    expect(u.relays.every((r) => r.ok)).toBe(true);
    expect(a.lists!.unlisted.has(storyId)).toBe(true);
    expect(calls.find((c) => c.path === "/moderation/audit")!.body.auditEvent.tags).toContainEqual([
      "e",
      "c".repeat(64),
    ]);
    expect(calls.find((c) => c.path === "/moderation/unlist")!.body.storyId).toBe(storyId);
    // each change is a newer replaceable event even within the same second
    const ev = [...pool.events.values()].filter(
      (e) => e.pubkey === modA.pubkey && e.tags[0]![1] === "azaad:list:hidden",
    );
    expect(ev).toHaveLength(1);
    const again = await changeList(a, modA.secretKey, modA.pubkey, "hidden", [{ op: "remove", value: "c".repeat(64) }]);
    expect(again.event.created_at).toBeGreaterThan(ev[0]!.created_at - 1);
    expect(a.lists!.hidden.has("c".repeat(64))).toBe(false);
    a.unwatch();
  });

  it("records the audit failure but still publishes when the API is down", async () => {
    const { a } = app();
    await a.refresh();
    const r = await hideComment(a, null, modA.secretKey, modA.pubkey, "e".repeat(64));
    expect(r.auditError).toBe("no API configured");
    expect(a.lists!.hidden.has("e".repeat(64))).toBe(true);
    a.unwatch();
  });

  it("syncs signed contributor lists from the API", async () => {
    const { a } = app();
    await a.refresh();
    const { api } = await server();
    expect(await syncContributors(a, api, modA.secretKey, modA.pubkey)).toEqual({
      added: [contributor.pubkey],
      revoked: [owner.pubkey],
    });
    expect(a.lists!.contributors.has(contributor.pubkey)).toBe(true);
    expect(await syncContributors(a, api, modA.secretKey, modA.pubkey)).toEqual({ added: [], revoked: [] });
    a.unwatch();
  });
});
