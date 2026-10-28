#!/usr/bin/env node
/**
 * End-to-end test on the local dev network (spec §15 step 3 and §16 acceptance criteria).
 *
 * Prerequisites: `docker compose -f infra/dev/docker-compose.yml up -d --wait`, `node scripts/dev-setup.mjs`,
 * and built services (`pnpm -r build`). The script starts the API and the publisher itself.
 *
 * It drives real users with real keys and crypto: owner invite → contributor (real JPEG and MP4 carrying GPS/device
 * metadata, stripped on the "device") → moderator review → publisher pipeline → a clean client that knows only the
 * owner key reads and verifies everything from relays, gateways, Arweave and both chains. Then: tamper detection,
 * comments/reactions/hiding, change requests and rejection, unlisting and owner override, resilience with one server
 * of each kind stopped, the rebuild of the archive into an empty IPFS node, and a check that no logs contain IPs.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { nip44 } from "nostr-tools";
import {
  buildCommentThread,
  buildEffectiveLists,
  commentTemplate,
  countReactions,
  createAuditEvent,
  createAuthHeader,
  createInvite,
  createListEvent,
  createRedemption,
  decodeInvite,
  decryptBytes,
  decryptJson,
  editModeratorList,
  encryptBytes,
  encryptJson,
  fetchVerified,
  generateKeyPair,
  KIND_APP_DATA,
  KIND_COMMENT,
  KIND_REACTION,
  KIND_STORY,
  mineAndSign,
  newContentKey,
  parseSecretKey,
  parseStorageReceipt,
  reactionTemplate,
  RelayPool,
  selectStories,
  signApproval,
  sourcesFor,
  unwrapKey,
  verifyManifest,
  wrapKey,
  wrapKeyFor,
} from "@azaadawaaz/core";
import { approvalBodySha256, sha256Hex, storyIdToBytes16, uuidv7, validateApprovalBody } from "@azaadawaaz/schema";
import { findMetadata, INFORMATIONAL_FINDINGS, stripMetadata } from "@azaadawaaz/media-strip";
import { rebuildArchive } from "./lib/archive.mjs";
import { repoRoot } from "./lib/common.mjs";

const cfg = JSON.parse(readFileSync(join(repoRoot, ".dev/config.json"), "utf8"));
const keys = JSON.parse(readFileSync(join(repoRoot, ".dev/keys.json"), "utf8"));
const API = cfg.apiUrl;
const OWNER = parseSecretKey(keys.owner.nsec);
const MOD = keys.moderators[0];
const MOD_SK = parseSecretKey(MOD.nsec);
const MOD_B_SK = parseSecretKey(keys.moderators[1].nsec);
const PUBLISHER_EVM = (await import("viem/accounts")).privateKeyToAccount(keys.publisher.evmPrivateKey).address;
const compose = ["compose", "-f", join(repoRoot, "infra/dev/docker-compose.yml")];

// ---------- tiny test harness ----------
const results = [];
let current = "setup";
const section = (name) => {
  current = name;
  console.log(`\n▶ ${name}`);
};
function check(name, cond, detail) {
  results.push({ section: current, name, ok: Boolean(cond), detail });
  console.log(
    `  ${cond ? "✓" : "✗"} ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
  );
  return Boolean(cond);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (died.length) throw new Error(died.join("; "));
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

// ---------- services ----------
const logs = { api: [], publisher: [], media: [] };
const children = [];
let stopping = false;
const died = [];
function start(name, cmd, args, env) {
  const p = spawn(cmd, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const sink = (d) => logs[name].push(...d.toString().split("\n").filter(Boolean));
  p.stdout.on("data", sink);
  p.stderr.on("data", sink);
  p.on("exit", (code) => {
    if (!stopping) died.push(`${name} exited with code ${code}`);
  });
  children.push(p);
  return p;
}
function stopAll() {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
}
process.on("exit", stopAll);

async function call(sk, method, path, body) {
  const isRaw = body instanceof Uint8Array;
  const payload = body === undefined ? undefined : isRaw ? body : JSON.stringify(body);
  const headers = {};
  if (sk) headers.authorization = createAuthHeader(API + path, method, sk, payload);
  if (payload !== undefined) headers["content-type"] = isRaw ? "application/octet-stream" : "application/json";
  const r = await fetch(API + path, { method, headers, body: payload });
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer());
  if (!r.ok)
    throw Object.assign(new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`), {
      status: r.status,
      data,
    });
  return data;
}

const pool = new RelayPool({ websocketImplementation: WebSocket });

/** What a clean client does: knows only the owner key and some relays. */
async function cleanClientLists(relays = cfg.relays) {
  const ev = await pool.query(relays, { kinds: [KIND_APP_DATA], authors: [cfg.ownerPubkey] }, 5000);
  const first = buildEffectiveLists(cfg.ownerPubkey, ev);
  const mods = [...first.activeModerators];
  if (mods.length) ev.push(...(await pool.query(relays, { kinds: [KIND_APP_DATA], authors: mods }, 5000)));
  return buildEffectiveLists(cfg.ownerPubkey, ev);
}

// ---------- media as a phone would produce it ----------
function makeMedia(dir) {
  const jpg = join(dir, "photo.jpg");
  const mp4 = join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1600x900",
    "-frames:v",
    "1",
    "-q:v",
    "3",
    jpg,
  ]);
  execFileSync("exiftool", [
    "-q",
    "-overwrite_original",
    "-GPSLatitude=28.6139",
    "-GPSLatitudeRef=N",
    "-GPSLongitude=77.2090",
    "-GPSLongitudeRef=E",
    "-Make=Samsung",
    "-Model=SM-G991B",
    "-DateTimeOriginal=2026:10:20 07:15:00",
    "-Artist=Real Name",
    jpg,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-metadata",
    "location=+28.6139+077.2090/",
    "-metadata",
    "make=Samsung",
    "-metadata",
    "model=SM-G991B",
    "-metadata",
    "creation_time=2026-10-20T07:15:00Z",
    "-movflags",
    "+use_metadata_tags",
    mp4,
  ]);
  return { jpg: new Uint8Array(readFileSync(jpg)), mp4: new Uint8Array(readFileSync(mp4)) };
}
const leftovers = (b, mime) => findMetadata(b, mime).filter((f) => !INFORMATIONAL_FINDINGS.includes(f));

// =====================================================================================================================
async function main() {
  const work = mkdtempSync(join(tmpdir(), "azaad-e2e-"));
  const stagingDir = join(repoRoot, cfg.stagingDir);
  mkdirSync(stagingDir, { recursive: true });

  section("start API and publisher");
  start("api", "node", ["services/api/dist/main.js"], {
    PORT: "8787",
    PUBLIC_URL: API,
    DATABASE_URL: cfg.databaseUrl,
    STAGING_DIR: stagingDir,
    OWNER_PUBKEY: cfg.ownerPubkey,
    RELAYS: cfg.relays.join(","),
    LISTS_REFRESH_SECONDS: "2",
    AUTO_MIGRATE: "true",
  });
  await until(async () => (await fetch(`${API}/health`).catch(() => null))?.ok, 30000, "API health");
  await until(async () => (await (await fetch(`${API}/config`)).json()).moderators?.length > 0, 30000, "API lists");
  // Media runs as the isolated worker, as in production (security review #7); the publisher only talks HTTP to it.
  const mediaShared = join(repoRoot, cfg.workDir);
  mkdirSync(mediaShared, { recursive: true });
  start("media", "node", ["services/media/dist/server.js"], {
    MEDIA_SHARED_DIR: mediaShared,
    MEDIA_PORT: "3011",
    MEDIA_HOST: "127.0.0.1",
  });
  await until(async () => (await fetch("http://127.0.0.1:3011/health").catch(() => null))?.ok, 20000, "media worker");
  start("publisher", "node", ["services/publisher/dist/main.js"], {
    POLL_MS: "500",
    STAGING_DIR: stagingDir,
    MEDIA_URL: "http://127.0.0.1:3011",
    MEDIA_SHARED_DIR: mediaShared,
  });
  await sleep(1500);
  check("API is up with the signed lists", true);

  // ------------------------------------------------------------------
  section("owner invites a contributor; contributor redeems on a new key");
  const invite = createInvite(OWNER, { expiresAt: Math.floor(Date.now() / 1000) + 3600, note: "e2e" });
  const contributor = generateKeyPair();
  const red = await call(null, "POST", "/invites/redeem", {
    redemption: createRedemption(decodeInvite(invite.link), contributor.secretKey),
  });
  check("redeemed", red.contributor === contributor.pubkey);
  const reuse = await call(null, "POST", "/invites/redeem", {
    redemption: createRedemption(decodeInvite(invite.link), generateKeyPair().secretKey),
  }).catch((e) => e);
  check("an invite works only once", reuse instanceof Error && reuse.status >= 400);

  // ------------------------------------------------------------------
  section("on-device metadata stripping (spec §4.1, §16)");
  const raw = makeMedia(work);
  check(
    "the photo carries GPS before stripping",
    findMetadata(raw.jpg, "image/jpeg").includes("gps"),
    findMetadata(raw.jpg, "image/jpeg"),
  );
  check(
    "the clip carries location before stripping",
    findMetadata(raw.mp4, "video/mp4").includes("mp4:location"),
    findMetadata(raw.mp4, "video/mp4"),
  );
  const jpg = stripMetadata(raw.jpg, "image/jpeg");
  const mp4 = stripMetadata(raw.mp4, "video/mp4");
  check("photo metadata removed ✓", leftovers(jpg, "image/jpeg").length === 0, leftovers(jpg, "image/jpeg"));
  check("clip metadata removed ✓", leftovers(mp4, "video/mp4").length === 0, leftovers(mp4, "video/mp4"));
  const exif = execFileSync("exiftool", ["-s", "-G", "-"], { input: jpg }).toString();
  check("exiftool finds no GPS, device or name in the photo", !/GPS|Samsung|SM-G991B|Real Name/.test(exif));
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-"], {
    input: mp4,
  }).toString();
  check("ffprobe finds no location or device in the clip", !/28\.6139|Samsung|SM-G991B/.test(probe));

  // ------------------------------------------------------------------
  section("contributor submits a bilingual story with text, a gallery, a video and an embed");
  const conf = await call(null, "GET", "/config");
  const recipients = [conf.ownerX25519, ...conf.moderators.map((m) => m.x25519)];
  const storyId = uuidv7();
  const jpgSha = sha256Hex(jpg);
  const mp4Sha = sha256Hex(mp4);
  const body = {
    schema: "azaadawaaz/story@1",
    id: storyId,
    version: 1,
    supersedes: null,
    language: "both",
    title: { en: "Floods in the valley", hi: "घाटी में बाढ़" },
    summary: { en: "What we saw at dawn by the old bridge.", hi: "पुराने पुल के पास सुबह हमने क्या देखा।" },
    cover: { sha256: jpgSha },
    tags: ["floods", "बाढ़"],
    location: { en: "Northern district", hi: "उत्तरी ज़िला" },
    contributor: { pubkey: contributor.npub, displayName: "Valley correspondent" },
    blocks: [
      {
        type: "text",
        markdown: { en: "## Morning\nWater rose **over** the bridge.", hi: "## सुबह\nपानी पुल के **ऊपर** आ गया।" },
      },
      { type: "image", items: [{ sha256: jpgSha, caption: { en: "The bridge", hi: "पुल" } }] },
      { type: "video", source: { sha256: mp4Sha }, title: { en: "Six seconds at the bridge" } },
      { type: "embed-story", storyId: uuidv7() },
    ],
  };
  check("approval body is valid", validateApprovalBody(body).ok, validateApprovalBody(body));
  const contentKey = await newContentKey();
  const blobs = {
    [jpgSha]: await encryptBytes(jpg, contentKey, 256 * 1024),
    [mp4Sha]: await encryptBytes(mp4, contentKey, 256 * 1024),
  };
  // Use 256 KiB chunks here to exercise multi-chunk resume with small files; the API reads the chunk size from /config.
  const chunkSize = conf.limits?.chunkSize ?? 1024 * 1024;
  const enc = {
    [jpgSha]: await encryptBytes(jpg, contentKey, chunkSize),
    [mp4Sha]: await encryptBytes(mp4, contentKey, chunkSize),
  };
  void blobs;
  const { id: subId } = await call(contributor.secretKey, "POST", "/submissions", {
    storyId,
    version: 1,
    supersedes: null,
    bodyCiphertext: await encryptJson(body, contentKey),
    wrappedKeys: await wrapKeyFor(contentKey, recipients),
    media: [
      { sha256: jpgSha, size: jpg.length, mime: "image/jpeg", kind: "image", chunks: enc[jpgSha].chunks.length },
      { sha256: mp4Sha, size: mp4.length, mime: "video/mp4", kind: "video", chunks: enc[mp4Sha].chunks.length },
    ],
  });
  for (const sha of [jpgSha, mp4Sha]) {
    const base = `/submissions/${subId}/media/${sha}`;
    await call(contributor.secretKey, "PUT", `${base}/header`, enc[sha].header);
    // Upload the first chunk, "lose the connection", ask the server what it has, and resume.
    await call(contributor.secretKey, "PUT", `${base}/chunks/0`, enc[sha].chunks[0]);
    const st = await call(contributor.secretKey, "GET", `${base}/status`);
    for (let n = 0; n < enc[sha].chunks.length; n++)
      if (!st.received.includes(n)) await call(contributor.secretKey, "PUT", `${base}/chunks/${n}`, enc[sha].chunks[n]);
    await call(contributor.secretKey, "POST", `${base}/complete`);
  }
  const submitted = await call(contributor.secretKey, "POST", `/submissions/${subId}/submit`);
  check("submitted", submitted.state === "submitted");

  section("nothing is public before approval (spec §1.1 principle 2)");
  const early = await pool.query(cfg.relays, { kinds: [KIND_STORY], "#d": [storyId] }, 3000);
  check("no story event on relays", early.length === 0);
  const stagingFile = readFileSync(join(stagingDir, subId, jpgSha, "0"));
  check("staged media is ciphertext (no JPEG header on disk)", !(stagingFile[0] === 0xff && stagingFile[1] === 0xd8));

  // ------------------------------------------------------------------
  section("moderator reviews: claim, decrypt, verify media, approve");
  await call(MOD_SK, "POST", `/submissions/${subId}/claim`, {
    auditEvent: createAuditEvent({ action: "claim", submissionId: subId }, MOD_SK),
  });
  const sub = await call(MOD_SK, "GET", `/submissions/${subId}?x25519=${MOD.x25519}`);
  const key = await unwrapKey(sub.wrappedKey, { publicKey: MOD.x25519, privateKey: MOD.x25519Private });
  const seen = await decryptJson(sub.bodyCiphertext, key);
  check("moderator sees exactly what the contributor wrote", approvalBodySha256(seen) === approvalBodySha256(body));
  for (const sha of [jpgSha, mp4Sha]) {
    const base = `/submissions/${subId}/media/${sha}`;
    const header = await call(MOD_SK, "GET", `${base}/header`);
    const chunks = [];
    for (let n = 0; n < enc[sha].chunks.length; n++) chunks.push(await call(MOD_SK, "GET", `${base}/chunks/${n}`));
    check(
      `moderator decrypts media ${sha.slice(0, 8)} and its hash matches`,
      sha256Hex(await decryptBytes({ header, chunks }, key)) === sha,
    );
  }
  const approval = signApproval(seen, MOD_SK);
  const tApprove = Date.now();
  await call(MOD_SK, "POST", `/submissions/${subId}/approve`, {
    approval,
    approvalBodySha256: approvalBodySha256(seen),
    publisherWrappedKey: await wrapKey(key, conf.publisher.x25519),
    auditEvent: createAuditEvent({ action: "approve", submissionId: subId, storyId }, MOD_SK),
  });
  const second = await call(MOD_B_SK, "POST", `/submissions/${subId}/approve`, {
    approval: signApproval(seen, MOD_B_SK),
    approvalBodySha256: approvalBodySha256(seen),
    publisherWrappedKey: await wrapKey(key, conf.publisher.x25519),
    auditEvent: createAuditEvent({ action: "approve", submissionId: subId, storyId }, MOD_B_SK),
  }).catch((e) => e);
  check("one approval publishes; a second is refused", second instanceof Error && second.status === 409);

  // ------------------------------------------------------------------
  section("publisher pipeline");
  const job = async () =>
    (await call(MOD_SK, "GET", "/jobs")).find((j) => (j.submissionId ?? j.submission_id) === subId);
  const published = await until(
    async () => {
      const j = await job();
      if (j?.state === "failed" && j.attempts > 2) throw new Error(`publish job failing: ${JSON.stringify(j.steps)}`);
      return j?.submissionState === "published" ? j : null;
    },
    600000,
    "story published",
  );
  const tPublished = Date.now();
  const mediaDone = Date.parse(published.steps?.media?.at ?? new Date(tApprove).toISOString());
  check(
    "published",
    true,
    `${((tPublished - tApprove) / 1000).toFixed(1)} s after approval, ${((tPublished - mediaDone) / 1000).toFixed(1)} s after media processing`,
  );
  check("readable within 2 minutes of processing finishing (spec §16)", tPublished - mediaDone < 120000);
  const done = await until(
    async () => {
      const j = await job();
      if (j?.state === "failed" && j.attempts > 3)
        throw new Error(`job failing after publication: ${JSON.stringify(j.steps)}`);
      return j?.state === "done" ? j : null;
    },
    600000,
    "all steps done",
  );
  check("all pipeline steps done (chains, Arweave, storage receipt)", true, Object.keys(done.steps ?? {}).join(" → "));

  // ------------------------------------------------------------------
  section("a clean client reads and verifies the story (no API, no database)");
  const lists = await cleanClientLists();
  const storyEvents = await pool.query(
    cfg.relays,
    { kinds: [KIND_STORY], authors: lists.serviceKeys.map((k) => k.pubkey) },
    5000,
  );
  const ref = selectStories(storyEvents, lists).find((s) => s.storyId === storyId);
  check("story listed from relays", Boolean(ref));
  const manifestBytes = await fetchVerified({
    sources: sourcesFor({ cid: ref.manifestCid }, lists.gateways),
    sha256: ref.manifestSha256,
  });
  const v = verifyManifest(manifestBytes, ref, lists);
  check("Verify: manifest hash, schema, approval signature, moderator and publisher all pass", v.ok, v.errors);
  const m = v.manifest;
  check(
    "manifest has every block type",
    ["text", "image", "video", "embed-story"].every((t) => m.blocks.some((b) => b.type === t)),
  );
  check("approved image published byte-for-byte", m.blocks[1].items[0].sha256 === jpgSha);
  const img = await fetchVerified({
    sources: sourcesFor({ cid: m.blocks[1].items[0].cid }, lists.gateways),
    sha256: jpgSha,
  });
  check("image fetched from a gateway matches its hash", sha256Hex(img) === jpgSha);
  check("published image has no metadata", leftovers(img, "image/jpeg").length === 0);
  const vid = m.blocks[2];
  for (const [name, f] of [
    ["mp4", vid.mp4],
    ["poster", vid.poster],
    ["preview", vid.preview],
  ]) {
    const b = await fetchVerified({
      sources: sourcesFor({ cid: f.cid }, lists.gateways),
      sha256: f.sha256,
      maxBytes: 200 * 1024 * 1024,
    });
    check(`video ${name} verified from a gateway`, sha256Hex(b) === f.sha256);
  }
  const master = await (await fetch(`${cfg.ipfsGateways[1]}/ipfs/${vid.hls}`)).text();
  check("HLS master playlist reachable through the second gateway", master.startsWith("#EXTM3U"));
  check(
    "video has a magnet link with web seeds",
    (vid.magnet ?? "").startsWith("magnet:?xt=urn:btih:") && vid.magnet.includes("ws="),
  );
  for (const variant of Object.values(m.blocks[1].items[0].variants ?? {})) {
    const r = await fetch(`${cfg.ipfsGateways[0]}/ipfs/${variant}`);
    check(`variant ${variant.slice(0, 12)}… served`, r.ok && (r.headers.get("content-type") ?? "").includes("webp"));
  }

  section("Verify: Arweave copy and on-chain receipts on both chains");
  const receiptEvents = await pool.query(cfg.relays, { kinds: [KIND_APP_DATA], authors: [ref.publisher] }, 5000);
  const sr = receiptEvents.map((e) => parseStorageReceipt(e, lists)).find((r) => r?.storyId === storyId);
  check("storage receipt published", Boolean(sr?.arweave?.[ref.manifestSha256]));
  const arBytes = new Uint8Array(await (await fetch(`${cfg.arweave}/${sr.arweave[ref.manifestSha256]}`)).arrayBuffer());
  check("manifest on Arweave matches", sha256Hex(arBytes) === ref.manifestSha256);
  check(
    "image on Arweave matches",
    Boolean(sr.arweave[jpgSha]) &&
      sha256Hex(new Uint8Array(await (await fetch(`${cfg.arweave}/${sr.arweave[jpgSha]}`)).arrayBuffer())) === jpgSha,
  );
  for (const c of cfg.chains) {
    const onChain = await receiptOnChain(c, storyId, 1, PUBLISHER_EVM);
    check(
      `receipt on ${c.key} (chain ${c.chainId}) matches the manifest hash`,
      onChain.sha === ref.manifestSha256,
      onChain,
    );
  }

  section("tampered copies fail verification (spec §16)");
  const tampered = manifestBytes.slice();
  tampered[tampered.length - 20] ^= 1;
  check("one flipped byte → red", !verifyManifest(tampered, ref, lists).ok);

  // ------------------------------------------------------------------
  section("comments and reactions (spec §7)");
  const reader = generateKeyPair();
  const comment = await mineAndSign(
    commentTemplate({ story: ref, content: "Thank you for this report." }),
    reader.secretKey,
    16,
  );
  const reply = await mineAndSign(
    commentTemplate({ story: ref, content: "Seconded.", parent: comment }),
    generateKeyPair().secretKey,
    16,
  );
  const spam = { ...comment, id: "0".repeat(64) };
  const pubRes = await pool.publish(cfg.relays, comment);
  await pool.publish(cfg.relays, reply);
  check(
    "comment with proof-of-work accepted by relays",
    pubRes.every((r) => r.ok),
    pubRes,
  );
  const noPow = await mineAndSign(commentTemplate({ story: ref, content: "no work" }), reader.secretKey, 0);
  const rej = await pool.publish(cfg.relays, noPow);
  check(
    "comment without proof-of-work rejected by our relays",
    rej.every((r) => !r.ok),
    rej.map((r) => r.message),
  );
  void spam;
  const reaction = await mineAndSign(reactionTemplate({ story: ref, reaction: "⭐" }), reader.secretKey, 16);
  await pool.publish(cfg.relays, reaction);
  const social = await pool.query(cfg.relays, { kinds: [KIND_COMMENT, KIND_REACTION], "#A": [ref.address] }, 4000);
  social.push(...(await pool.query(cfg.relays, { kinds: [KIND_REACTION], "#a": [ref.address] }, 4000)));
  const thread = buildCommentThread(social, ref.address, lists);
  check(
    "comment thread shows comment and reply",
    thread[0]?.event.id === comment.id && thread[0]?.replies[0]?.event.id === reply.id,
  );
  check("⭐ important counted", countReactions(social, ref.address, lists)["⭐"] === 1);
  const hidden = createListEvent("hidden", editModeratorList([], "add", comment.id), MOD_B_SK);
  await pool.publish(cfg.relays, hidden);
  await call(MOD_B_SK, "POST", "/moderation/audit", {
    auditEvent: createAuditEvent({ action: "hide", eventId: comment.id }, MOD_B_SK),
  });
  const lists2 = await cleanClientLists();
  check(
    "hidden comment (and its replies) disappear from official clients",
    buildCommentThread(social, ref.address, lists2).length === 0,
  );

  // ------------------------------------------------------------------
  section("changes requested → resubmit → rejected, with reasons for the contributor");
  const id2 = uuidv7();
  const body2 = { ...structuredClone(body), id: id2, blocks: [body.blocks[0]], cover: undefined };
  delete body2.cover;
  const ck2 = await newContentKey();
  const { id: sub2 } = await call(contributor.secretKey, "POST", "/submissions", {
    storyId: id2,
    version: 1,
    supersedes: null,
    bodyCiphertext: await encryptJson(body2, ck2),
    wrappedKeys: await wrapKeyFor(ck2, recipients),
    media: [],
  });
  await call(contributor.secretKey, "POST", `/submissions/${sub2}/submit`);
  await call(MOD_SK, "POST", `/submissions/${sub2}/claim`, {
    auditEvent: createAuditEvent({ action: "claim", submissionId: sub2 }, MOD_SK),
  });
  const convo = (sk, pub) => nip44.v2.utils.getConversationKey(sk, pub);
  const note = nip44.v2.encrypt("Please add the date of the flood.", convo(MOD_SK, contributor.pubkey));
  await call(MOD_SK, "POST", `/submissions/${sub2}/request-changes`, {
    feedback: note,
    auditEvent: createAuditEvent({ action: "request_changes", submissionId: sub2 }, MOD_SK),
  });
  let mine = (await call(contributor.secretKey, "GET", "/me/submissions")).find((s) => s.id === sub2);
  const fb = mine.feedback?.[0];
  const fbText = fb ? nip44.v2.decrypt(fb.nip44, convo(contributor.secretKey, fb.moderator)) : "";
  check(
    "contributor reads the change request",
    mine.state === "changes_requested" && fbText.includes("date of the flood"),
    fbText,
  );
  body2.blocks = [{ type: "text", markdown: { en: "## 20 October\nWater rose.", hi: "## 20 अक्टूबर\nपानी बढ़ा।" } }];
  await call(contributor.secretKey, "PUT", `/submissions/${sub2}`, {
    storyId: id2,
    version: 1,
    supersedes: null,
    bodyCiphertext: await encryptJson(body2, ck2),
    wrappedKeys: await wrapKeyFor(ck2, recipients),
    media: [],
  });
  await call(contributor.secretKey, "POST", `/submissions/${sub2}/submit`);
  await call(MOD_SK, "POST", `/submissions/${sub2}/claim`, {
    auditEvent: createAuditEvent({ action: "claim", submissionId: sub2 }, MOD_SK),
  });
  await call(MOD_SK, "POST", `/submissions/${sub2}/reject`, {
    feedback: nip44.v2.encrypt("We can't verify the source.", convo(MOD_SK, contributor.pubkey)),
    auditEvent: createAuditEvent({ action: "reject", submissionId: sub2 }, MOD_SK),
  });
  mine = (await call(contributor.secretKey, "GET", "/me/submissions")).find((s) => s.id === sub2);
  check("rejected with a reason the contributor can read", mine.state === "rejected" && mine.feedback.length === 2);
  const leaked = await pool.query(cfg.relays, { kinds: [9737], "#story": [id2] }, 3000);
  check("public audit events don't reveal the rejected story id", leaked.length === 0);

  // ------------------------------------------------------------------
  section("unlisting and the owner override (spec §5.4)");
  await call(MOD_B_SK, "POST", "/moderation/unlist", {
    storyId,
    auditEvent: createAuditEvent({ action: "unlist", storyId }, MOD_B_SK),
  });
  await pool.publish(cfg.relays, createListEvent("unlisted", editModeratorList([], "add", storyId), MOD_B_SK));
  const l3 = await cleanClientLists();
  check(
    "unlisted story disappears from official clients",
    !selectStories(storyEvents, l3).some((s) => s.storyId === storyId),
  );
  check("…but its copies are still verifiable", verifyManifest(manifestBytes, ref, l3).ok);
  const alerts = await call(OWNER, "GET", "/owner/alerts");
  check("owner is alerted about the unlisting", JSON.stringify(alerts).includes("unlist"));
  await pool.publish(cfg.relays, createListEvent("overrides", [{ list: "unlisted", value: storyId }], OWNER));
  const l4 = await cleanClientLists();
  check(
    "owner override re-lists it",
    selectStories(storyEvents, l4).some((s) => s.storyId === storyId),
  );

  // ------------------------------------------------------------------
  section("resilience: any one server down, every story still readable (spec §16)");
  for (const svc of ["relay-a", "ipfs-a", "anvil"]) {
    execFileSync("docker", [...compose, "stop", svc], { stdio: "ignore" });
    try {
      const L = await cleanClientLists();
      const evs = await pool.query(
        cfg.relays,
        { kinds: [KIND_STORY], authors: L.serviceKeys.map((k) => k.pubkey) },
        4000,
      );
      const r = selectStories(evs, L).find((s) => s.storyId === storyId);
      const b =
        r &&
        (await fetchVerified({
          sources: sourcesFor({ cid: r.manifestCid }, L.gateways),
          sha256: r.manifestSha256,
          timeoutMs: 4000,
        }).catch(() => null));
      const ok = Boolean(b && verifyManifest(b, r, L).ok);
      let chainOk = true;
      if (svc === "anvil") chainOk = (await receiptOnChain(cfg.chains[1], storyId, 1, PUBLISHER_EVM)).sha === ref.manifestSha256;
      check(`with ${svc} stopped the story is listed, fetched and verified`, ok && chainOk);
    } finally {
      execFileSync("docker", [...compose, "start", svc], { stdio: "ignore" });
    }
  }
  await sleep(3000);

  // ------------------------------------------------------------------
  section("rebuild the archive from public networks into an empty IPFS node, no database (spec §11)");
  execFileSync("docker", ["rm", "-f", "e2e-rebuild-ipfs"], { stdio: "ignore" });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      "e2e-rebuild-ipfs",
      "-p",
      "127.0.0.1:5099:5001",
      "ipfs/kubo:v0.38.1",
      "daemon",
      "--offline",
    ],
    { stdio: "ignore" },
  );
  try {
    await until(
      async () => (await fetch("http://127.0.0.1:5099/api/v0/id", { method: "POST" }).catch(() => null))?.ok,
      60000,
      "empty kubo",
    );
    const report = await rebuildArchive({
      owner: cfg.ownerPubkey,
      relays: cfg.relays,
      gateways: cfg.ipfsGateways,
      arweaveUrl: cfg.arweave,
      chains: cfg.chains,
      pinTo: "http://127.0.0.1:5099",
      outDir: join(work, "rebuilt"),
    });
    check(
      "rebuild found every story and version with no problems",
      report.problems.length === 0 && report.versions >= 1,
      report.problems,
    );
    const back = await fetch(`http://127.0.0.1:5099/api/v0/cat?arg=${ref.manifestCid}`, { method: "POST" });
    check(
      "the empty (offline) node now holds the verified manifest",
      sha256Hex(new Uint8Array(await back.arrayBuffer())) === ref.manifestSha256,
    );
    const vback = await fetch(`http://127.0.0.1:5099/api/v0/cat?arg=${vid.mp4.cid}`, { method: "POST" });
    check("…and the video", sha256Hex(new Uint8Array(await vback.arrayBuffer())) === vid.mp4.sha256);
  } finally {
    execFileSync("docker", ["rm", "-f", "e2e-rebuild-ipfs"], { stdio: "ignore" });
  }

  // ------------------------------------------------------------------
  section("no IP addresses in our logs (spec §12)");
  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;
  check(
    "API logs contain no IP addresses",
    !logs.api.some((l) => ipRe.test(l)),
    logs.api.find((l) => ipRe.test(l)),
  );
  check(
    "publisher logs contain no IP addresses",
    !logs.publisher.some((l) => ipRe.test(l)),
    logs.publisher.find((l) => ipRe.test(l)),
  );
  for (const svc of ["relay-a", "relay-b"]) {
    const out = execFileSync("docker", [...compose, "logs", "--no-log-prefix", svc]).toString();
    check(
      `${svc} logs contain no client IP addresses`,
      !ipRe.test(out.replace(/0\.0\.0\.0/g, "")),
      out.split("\n").find((l) => ipRe.test(l)),
    );
  }

  writeFileSync(join(work, "logs.json"), JSON.stringify(logs, null, 2));
}

async function receiptOnChain(chain, storyId, version, by) {
  // eth_call receipt(bytes16,uint32,address): receipts are stored per writer (decision D19).
  const { keccak256, toBytes, encodeAbiParameters, decodeAbiParameters } = await import("viem");
  const selector = keccak256(toBytes("receipt(bytes16,uint32,address)")).slice(0, 10);
  const data =
    selector +
    encodeAbiParameters(
      [{ type: "bytes16" }, { type: "uint32" }, { type: "address" }],
      [storyIdToBytes16(storyId), version, by],
    ).slice(2);
  const res = await fetch(chain.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: chain.registry, data }, "latest"],
    }),
  });
  const { result, error } = await res.json();
  if (error) return { error: error.message };
  const [sha, ts] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], result);
  return { sha: sha.slice(2), timestamp: Number(ts) };
}

try {
  await main();
} catch (e) {
  check("unexpected error", false, e.stack ?? String(e));
  console.log("\n--- last API log lines ---\n" + logs.api.slice(-15).join("\n"));
  console.log("--- last publisher log lines ---\n" + logs.publisher.slice(-25).join("\n"));
} finally {
  stopAll();
  pool.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("Failed:\n" + failed.map((f) => ` - [${f.section}] ${f.name}`).join("\n"));
  process.exit(1);
}
process.exit(0);
