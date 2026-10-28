import { createHash } from "node:crypto";
import {
  CHUNK_SIZE,
  Decryptor,
  Encryptor,
  buildEffectiveLists,
  createListEvent,
  decryptJson,
  generateEncryptionKeyPair,
  newContentKey,
  sodiumReady,
  unwrapKey,
  verifyAuthHeader,
  type EncryptionKeyPair,
} from "@azaadawaaz/core";
import { Api, type ApiConfig } from "../../api/client";
import { signerFromSecret } from "../../api/nip98";
import { joinPath } from "../../platform/types";
import { fakeHttp, nodeFs } from "../../test/nodePlatform";
import { NOW, contributor, modA, modB, owner, publisher } from "../../test/fixtures";
import { bytesToBase64, base64ToBytes, concatBytes } from "../../util/bytes";
import { toApprovalBody, withStoryId, newDraft } from "../draft";
import { KeyCheckError, newUploadState, recipientsFor, runUpload, type EncryptedMedia, type UploadState } from "../upload";

const API = "https://api.example";
let ownerX: EncryptionKeyPair, modAX: EncryptionKeyPair, modBX: EncryptionKeyPair;
let lists: ReturnType<typeof buildEffectiveLists>;
let config: ApiConfig;

beforeAll(async () => {
  ownerX = await generateEncryptionKeyPair();
  modAX = await generateEncryptionKeyPair();
  modBX = await generateEncryptionKeyPair();
  lists = buildEffectiveLists(owner.pubkey, [
    createListEvent("moderators", [
      { pubkey: modA.pubkey, x25519: modAX.publicKey, from: NOW - 1000 },
      { pubkey: modB.pubkey, x25519: modBX.publicKey, from: NOW - 1000 },
    ], owner.secretKey, NOW - 100),
    createListEvent("service-keys", [
      { role: "owner", pubkey: owner.pubkey, x25519: ownerX.publicKey, from: NOW - 1000 },
      { role: "publisher", pubkey: publisher.pubkey, x25519: "55".repeat(32), from: NOW - 1000 },
    ], owner.secretKey, NOW - 100),
  ]);
  config = {
    ownerPubkey: owner.pubkey,
    ownerX25519: ownerX.publicKey,
    publisher: { pubkey: publisher.pubkey, x25519: "55".repeat(32) },
    moderators: [{ pubkey: modA.pubkey, x25519: modAX.publicKey }, { pubkey: modB.pubkey, x25519: modBX.publicKey }],
    relays: [],
    gateways: [],
    limits: {},
  };
});

describe("recipient keys", () => {
  it("wraps for exactly the owner and every signed moderator", () => {
    expect(recipientsFor(config, lists).sort()).toEqual([ownerX.publicKey, modAX.publicKey, modBX.publicKey].sort());
  });

  it("refuses a server that injects a key or leaves a moderator out", () => {
    expect(() => recipientsFor({ ...config, moderators: [...config.moderators, { pubkey: modA.pubkey, x25519: "66".repeat(32) }] }, lists)).toThrow(KeyCheckError);
    expect(() => recipientsFor({ ...config, moderators: [config.moderators[0]!] }, lists)).toThrow(/left out/);
    expect(() => recipientsFor({ ...config, ownerX25519: "77".repeat(32) }, lists)).toThrow(/owner/);
    expect(() => recipientsFor({ ...config, ownerPubkey: modA.pubkey }, lists)).toThrow(/pinned/);
  });
});

/** An in-memory services/api with the same rules for the routes the uploader uses. */
function fakeApi(fs: ReturnType<typeof nodeFs>, failChunkOnce?: number) {
  const subs = new Map<string, any>();
  const stats = { chunkPuts: 0, headerPuts: 0, submits: 0, failed: false };
  const expected = (size: number, n: number) => (n < Math.ceil(size / CHUNK_SIZE) - 1 ? CHUNK_SIZE + 17 : size - n * CHUNK_SIZE + 17);
  const http = fakeHttp((req) => {
    const u = new URL(req.url);
    const auth = verifyAuthHeader(req.headers.authorization, req.url, req.method, req.body ?? undefined);
    if (!auth.ok) return { status: 401, body: JSON.stringify({ error: "unauthorized", message: auth.error }) };
    const json = () => JSON.parse(new TextDecoder().decode(req.body));
    let m: RegExpMatchArray | null;
    if (req.method === "POST" && u.pathname === "/submissions") {
      const b = json();
      const id = `00000000-0000-4000-8000-00000000000${subs.size + 1}`;
      subs.set(id, { ...b, state: "draft", media: b.media.map((x: any) => ({ ...x, complete: false })), files: new Map<string, Map<string, Uint8Array>>() });
      return { status: 201, body: JSON.stringify({ id }) };
    }
    if ((m = u.pathname.match(/^\/submissions\/([^/]+)\/media\/([0-9a-f]{64})\/(header|chunks\/(\d+)|status|complete)$/))) {
      const s = subs.get(m[1]!);
      const media = s.media.find((x: any) => x.sha256 === m![2]);
      const files: Map<string, Uint8Array> = s.files.get(m[2]) ?? new Map();
      s.files.set(m[2], files);
      if (m[3] === "header") {
        stats.headerPuts++;
        files.set("header", req.body!);
        return { body: "{}" };
      }
      if (m[3] === "status") return { body: JSON.stringify({ received: [...files.keys()].filter((k) => k !== "header").map(Number).sort((a, b) => a - b), header: files.has("header"), complete: media.complete }) };
      if (m[3] === "complete") {
        const missing = [...Array(media.chunks).keys()].filter((n) => !files.has(String(n)));
        if (missing.length || !files.has("header")) return { status: 409, body: JSON.stringify({ error: "media_incomplete", message: "missing" }) };
        media.complete = true;
        return { body: "{}" };
      }
      const n = Number(m[4]);
      if (failChunkOnce !== undefined && stats.chunkPuts === failChunkOnce && !stats.failed) {
        stats.failed = true;
        throw new Error("connection reset");
      }
      stats.chunkPuts++;
      if (req.body!.length !== expected(media.size, n)) return { status: 400, body: JSON.stringify({ error: "invalid_chunk_size", message: "size" }) };
      files.set(String(n), req.body!);
      return { body: "{}" };
    }
    if ((m = u.pathname.match(/^\/submissions\/([^/]+)\/submit$/))) {
      const s = subs.get(m[1]!);
      if (s.media.some((x: any) => !x.complete)) return { status: 409, body: JSON.stringify({ error: "media_incomplete" }) };
      s.state = "submitted";
      stats.submits++;
      return { body: JSON.stringify({ id: m[1], state: "submitted" }) };
    }
    return { status: 404, body: "{}" };
  }, fs);
  return { http, subs, stats };
}

/** The native encryptFile contract, implemented with core's Encryptor. */
async function encryptFile(fs: ReturnType<typeof nodeFs>, src: string, outDir: string, key: Uint8Array, chunkSize: number): Promise<EncryptedMedia> {
  await sodiumReady();
  const data = await fs.readBytes(src);
  const enc = new Encryptor(key);
  await fs.mkdirs(outDir);
  await fs.writeBytes(joinPath(outDir, "header"), enc.header);
  const chunks = [];
  for (let off = 0, n = 0; off < data.length; off += chunkSize, n++) {
    const end = Math.min(off + chunkSize, data.length);
    const c = enc.push(data.subarray(off, end), end === data.length);
    const path = joinPath(outDir, String(n));
    await fs.writeBytes(path, c);
    chunks.push({ n, size: c.length, sha256: createHash("sha256").update(c).digest("hex"), path });
  }
  return { header: enc.header, chunks, plainSha256: createHash("sha256").update(data).digest("hex"), plainSize: data.length };
}

describe("encrypted, resumable upload", () => {
  it("survives an interruption, resends only what is missing, and moderators can decrypt", async () => {
    const fs = nodeFs();
    const video = Uint8Array.from({ length: 2 * CHUNK_SIZE + 12345 }, (_, i) => (i * 13) & 255);
    const image = Uint8Array.from({ length: 5000 }, (_, i) => i & 255);
    const vpath = joinPath(fs.paths.files, "v.mp4");
    const ipath = joinPath(fs.paths.files, "i.jpg");
    await fs.writeBytes(vpath, video);
    await fs.writeBytes(ipath, image);
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const d = withStoryId({
      ...newDraft("en"),
      title: { en: "T" },
      summary: { en: "S" },
      blocks: [
        { id: "1", type: "video", video: { path: vpath, sha256: sha(video), size: video.length, mime: "video/mp4", removed: [], metadataFree: true }, title: {}, description: {} },
        { id: "2", type: "image", items: [{ media: { path: ipath, sha256: sha(image), size: image.length, mime: "image/jpeg", removed: [], metadataFree: true }, caption: {} }] },
      ],
    });
    const body = toApprovalBody(d, contributor.npub);
    const key = await newContentKey();
    const { http, subs, stats } = fakeApi(fs, 1);
    const api = new Api(API, http, signerFromSecret(contributor.secretKey));
    const saved: UploadState[] = [];
    const deps = {
      api,
      encryptFile: (src: string, out: string, k: Uint8Array, cs: number) => encryptFile(fs, src, out, k, cs),
      removeDir: (dir: string) => fs.remove(dir),
      saveState: async (s: UploadState) => void saved.push(structuredClone(s)),
      workDir: joinPath(fs.paths.files, "enc"),
    };
    const codec = { toB64: bytesToBase64, fromB64: base64ToBytes };
    const state = newUploadState({
      draftId: d.localId, contentKey: key, storyId: d.storyId, version: 1, supersedes: null,
      media: [{ sha256: sha(video), size: video.length, mime: "video/mp4", kind: "video", path: vpath }, { sha256: sha(image), size: image.length, mime: "image/jpeg", kind: "image", path: ipath }],
      workDir: deps.workDir, toB64: bytesToBase64,
    });
    const recipients = recipientsFor(config, lists);
    await expect(runUpload(state, body, recipients, key, deps, codec)).rejects.toThrow(/connection reset/);
    const last = saved[saved.length - 1]!;
    expect(last.phase).toBe("created");
    expect(stats.chunkPuts).toBe(1);
    // Resume from the saved state (as after an app restart).
    const done = await runUpload(last, body, recipients, key, deps, codec);
    expect(done.phase).toBe("submitted");
    expect(stats.chunkPuts).toBe(4); // 1 before the failure, then the 2 remaining video chunks and the image chunk
    expect(stats.submits).toBe(1);
    const sub = subs.get(done.submissionId!)!;
    expect(sub.state).toBe("submitted");
    // A moderator unwraps the key, decrypts the body and the video, and the bytes match the approved hash.
    const modKey = await unwrapKey(sub.wrappedKeys[modBX.publicKey], modBX);
    expect(await decryptJson(sub.bodyCiphertext, modKey)).toEqual(body);
    const files: Map<string, Uint8Array> = sub.files.get(sha(video));
    const dec = new Decryptor(modKey, files.get("header")!);
    const plain = concatBytes([0, 1, 2].map((n) => dec.pull(files.get(String(n))!).data));
    expect(sha(plain)).toBe(sha(video));
    expect(Object.keys(sub.wrappedKeys).sort()).toEqual(recipients.sort());
    // local ciphertext is gone after submission
    expect((await fs.stat(joinPath(deps.workDir, sha(video)))).exists).toBe(false);
  });
});
