import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  approvalBodySha256,
  canonicalize,
  hexEquals,
  manifestSha256,
  mediaHashes,
  sha256Hex,
  STORY_SCHEMA,
  validateApprovalBody,
  validateManifest,
  type ApprovalBody,
  type Block,
  type Manifest,
} from "@azaadawaaz/schema";
import {
  createStorageReceiptEvent,
  createStoryEvent,
  decryptBytes,
  decryptJson,
  encryptionPublicKey,
  hexToNpub,
  npubToHex,
  RelayPool,
  unwrapKey,
  verifyApprovalSignature,
  wasModeratorAt,
  type EffectiveLists,
  type Event,
} from "@azaadawaaz/core";
import { processImage, processVideo } from "@azaadawaaz/media";
import { getPublicKey } from "nostr-tools/pure";
import type { PublisherConfig } from "./config.js";
import type { Job, PublisherDb, StepRecord, SubmissionRow } from "./db.js";
import { IpfsCluster, PinningClient, nodeOrigins, type DirEntry } from "./ipfs.js";
import { ArweaveStore } from "./arweave.js";
import { createVideoTorrent } from "./torrent.js";
import { writeReceipt } from "./chain.js";
import { loadLists, publishRelays } from "./lists.js";

/** A failure that retrying can't fix (revoked contributor, removed moderator, tampered body). The job is blocked. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Keep only the languages a localized field may have, so nothing unapproved rides along (security review #5). */
function lt<T extends { en?: string; hi?: string } | undefined>(t: T): T {
  if (!t) return t;
  const out: { en?: string; hi?: string } = {};
  if (typeof t.en === "string") out.en = t.en;
  if (typeof t.hi === "string") out.hi = t.hi;
  return out as T;
}

export interface PipelineDeps {
  config: PublisherConfig;
  db: PublisherDb;
  relays: RelayPool;
  ipfs: IpfsCluster;
  arweave: ArweaveStore;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Override list loading (tests). */
  lists?: () => Promise<EffectiveLists>;
  fetch?: typeof fetch;
}

/** Steps in order. Steps before `nostr` gate publication; the rest finish afterwards (spec §5.1, §6). */
export function stepNames(config: PublisherConfig): string[] {
  return [
    "decrypt",
    "checks",
    "media",
    "ipfs",
    "pin",
    "torrent",
    "manifest",
    "nostr",
    ...config.chains.map((c) => `chain:${c.key}`),
    "arweave",
    "storage-receipt",
    "finalize",
  ];
}

/** Steps whose output lives only in the work directory; if it was lost before `ipfs` finished, they re-run. */
const LOCAL_STEPS = ["decrypt", "checks", "media"];

interface ImageOut {
  sha256: string;
  mime: string;
  width: number;
  height: number;
  blurhash: string;
  variants: Record<string, { file: string; sha256: string; width: number; height: number }>;
}

interface VideoOut {
  sha256: string;
  hlsFiles: string[];
  mp4: { file: string; sha256: string };
  poster: { file: string; sha256: string; width: number; height: number };
  preview: { file: string; sha256: string };
  durationSec: number;
  width: number;
  height: number;
}

interface MediaResult {
  images: Record<string, ImageOut>;
  videos: Record<string, VideoOut>;
}

interface IpfsResult {
  images: Record<string, { cid: string; variants: Record<string, string> }>;
  videos: Record<string, { hlsDir: string; mp4: string; poster: string; preview: string }>;
}

export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  private work(id: string, ...p: string[]) {
    return join(this.d.config.workDir, id, ...p);
  }

  /** Run every unfinished step of a job. Throws on the first failure (the worker schedules a retry). */
  async run(job: Job): Promise<void> {
    const id = job.submission_id;
    const steps = job.steps ?? {};
    // If the work directory vanished before IPFS had everything, redo the local steps.
    if (!steps.ipfs?.done && LOCAL_STEPS.some((s) => steps[s]?.done) && !existsSync(this.work(id, "body.json"))) {
      for (const s of LOCAL_STEPS) delete steps[s];
    }
    const row = await this.d.db.getSubmission(id);
    // Long steps (video transcoding) can outlast the lock; keep extending it while we work.
    const heartbeat = setInterval(() => {
      this.d.db.extendLock(id, this.d.config.workerId).catch(() => {});
    }, 60_000);
    try {
      await this.runSteps(id, row, steps);
    } catch (e) {
      if (e instanceof PolicyError) {
        rmSync(this.work(id), { recursive: true, force: true });
        await this.d.db.blockJob(id, e.message);
        await this.d.db.alertOwner("publish_blocked", { submission: id, reason: e.message });
      }
      throw e;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runSteps(id: string, row: SubmissionRow, steps: Record<string, StepRecord>): Promise<void> {
    for (const name of stepNames(this.d.config)) {
      if (steps[name]?.done) continue;
      const prev = steps[name];
      const attempts = (prev?.attempts ?? 0) + 1;
      this.d.log("step start", { submission: id, step: name, attempts });
      try {
        const result = await this.runStep(name, row, steps);
        const rec: StepRecord = { done: true, result, attempts, at: new Date().toISOString() };
        steps[name] = rec;
        await this.d.db.saveStep(id, name, rec);
        await this.d.db.extendLock(id, this.d.config.workerId);
        this.d.log("step done", { submission: id, step: name });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const rec: StepRecord = { done: false, error, attempts, at: new Date().toISOString(), result: prev?.result };
        steps[name] = rec;
        await this.d.db.saveStep(id, name, rec);
        this.d.log("step failed", { submission: id, step: name, error });
        throw e;
      }
    }
  }

  private async runStep(name: string, row: SubmissionRow, steps: Record<string, StepRecord>): Promise<unknown> {
    if (name.startsWith("chain:")) return this.chain(name.slice(6), row, steps);
    switch (name) {
      case "decrypt":
        return this.decrypt(row);
      case "checks":
        return this.checks(row);
      case "media":
        return this.media(row);
      case "ipfs":
        return this.toIpfs(row, steps.media!.result as MediaResult);
      case "pin":
        return this.pin(row, steps);
      case "torrent":
        return this.torrent(row, steps);
      case "manifest":
        return this.manifest(row, steps);
      case "nostr":
        return this.nostr(row, steps);
      case "arweave":
        return this.toArweave(row, steps);
      case "storage-receipt":
        return this.storageReceipt(row, steps);
      case "finalize":
        return this.finalize(row, steps);
      default:
        throw new Error(`unknown step ${name}`);
    }
  }

  // ---- 1. Decrypt (spec §6 step 1) ----

  private async decrypt(row: SubmissionRow) {
    if (!row.publisher_wrapped_key) throw new Error("no content key wrapped for the publisher");
    const kp = {
      privateKey: this.d.config.publisherX25519Private,
      publicKey: await encryptionPublicKey(this.d.config.publisherX25519Private),
    };
    const key = await unwrapKey(row.publisher_wrapped_key, kp);
    const body = await decryptJson<ApprovalBody>(row.body_ciphertext, key);
    mkdirSync(this.work(row.id, "src"), { recursive: true });
    writeFileSync(this.work(row.id, "body.json"), JSON.stringify(body));
    for (const m of row.media) {
      if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error("bad media hash");
      const dir = join(this.d.config.stagingDir, row.id, m.sha256);
      const header = readFileSync(join(dir, "header"));
      const chunks = Array.from({ length: m.chunks }, (_, i) => new Uint8Array(readFileSync(join(dir, String(i)))));
      const plain = await decryptBytes({ header: new Uint8Array(header), chunks }, key);
      if (!hexEquals(sha256Hex(plain), m.sha256))
        throw new Error(`decrypted media does not match its hash ${m.sha256}`);
      writeFileSync(this.work(row.id, "src", m.sha256), plain);
    }
    return { media: row.media.length };
  }

  private body(row: SubmissionRow): ApprovalBody {
    return JSON.parse(readFileSync(this.work(row.id, "body.json"), "utf8"));
  }

  // ---- 2. Re-checks (spec §6 step 1) ----

  private async checks(row: SubmissionRow) {
    const body = this.body(row);
    const v = validateApprovalBody(body);
    if (!v.ok) throw new PolicyError(`approval body invalid: ${v.errors.join("; ")}`);
    if (!hexEquals(approvalBodySha256(body), row.approval_body_sha256))
      throw new PolicyError("decrypted body does not match the hash the moderator approved");
    if (!verifyApprovalSignature(body, row.approval)) throw new PolicyError("approval signature does not verify");
    if (body.id !== row.story_id || body.version !== row.version || body.supersedes !== (row.supersedes ?? null))
      throw new PolicyError("body id/version/supersedes differ from the submission");
    if (npubToHex(body.contributor.pubkey) !== row.contributor)
      throw new PolicyError("body contributor differs from submitter");

    const lists = await this.lists();
    const mod = npubToHex(row.approval.moderator);
    if (mod !== lists.owner && !lists.activeModerators.has(mod))
      throw new PolicyError("approving moderator is no longer on the list");
    // Revocation is decided by the owner through the API (database), not by any single moderator's signed list,
    // so a rogue moderator can't halt publishing by revoking everyone (security review #4).
    if (await this.d.db.isContributorRevoked(row.contributor)) throw new PolicyError("contributor has been revoked");
    if (row.version > 1) {
      const prev = await this.d.db.publishedVersion(row.story_id, row.version - 1);
      if (!prev) throw new Error(`version ${row.version - 1} of this story is not published yet`);
      if (prev.manifest_sha256 !== row.supersedes)
        throw new PolicyError("supersedes does not match the previous published version's manifest");
    }

    const kinds = new Map(row.media.map((m) => [m.sha256, m.kind]));
    for (const b of body.blocks) {
      if (b.type === "image")
        for (const i of b.items) if (kinds.get(i.sha256) !== "image") throw new Error(`image ${i.sha256} missing`);
      if (b.type === "video" && kinds.get(b.source.sha256) !== "video")
        throw new Error(`video ${b.source.sha256} missing`);
    }
    if (body.cover && kinds.get(body.cover.sha256) !== "image") throw new Error("cover image missing");
    const used = new Set(mediaHashes(body));
    const unused = row.media.filter((m) => !used.has(m.sha256)).map((m) => m.sha256);
    return { moderator: mod, unusedMedia: unused };
  }

  private listsCache?: { at: number; lists: EffectiveLists };
  private async lists(): Promise<EffectiveLists> {
    if (this.d.lists) return this.d.lists();
    if (this.listsCache && Date.now() - this.listsCache.at < 30_000) return this.listsCache.lists;
    const lists = await loadLists({
      pool: this.d.relays,
      relays: this.d.config.bootstrapRelays,
      ownerPubkey: this.d.config.ownerPubkey,
      bootstrapFile: this.d.config.bootstrapListEvents,
    });
    this.listsCache = { at: Date.now(), lists };
    return lists;
  }

  // ---- 3. Media processing (spec §4.1) ----

  private async media(row: SubmissionRow): Promise<MediaResult> {
    const body = this.body(row);
    const used = new Set(mediaHashes(body));
    const out: MediaResult = { images: {}, videos: {} };
    for (const m of row.media) {
      if (!used.has(m.sha256)) continue;
      const src = this.work(row.id, "src", m.sha256);
      if (m.kind === "image") {
        const dir = this.work(row.id, "out", "img", m.sha256);
        mkdirSync(dir, { recursive: true });
        const r = await this.processImageAt(src, dir);
        if (!hexEquals(r.originalSha256, m.sha256))
          throw new PolicyError(`image ${m.sha256} still carried metadata after on-device stripping; refusing to publish it`);
        out.images[m.sha256] = {
          sha256: m.sha256,
          mime: r.mime,
          width: r.width,
          height: r.height,
          blurhash: r.blurhash,
          variants: r.variants,
        };
      } else {
        const dir = this.work(row.id, "out", "vid", m.sha256);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const r = await this.processVideoAt(src, dir);
        out.videos[m.sha256] = {
          sha256: m.sha256,
          hlsFiles: listFiles(join(dir, r.hlsDir)).map((f) => relative(join(dir, r.hlsDir), f)),
          mp4: { file: r.mp4.path, sha256: r.mp4.sha256 },
          poster: { file: r.poster.path, sha256: r.poster.sha256, width: r.poster.width, height: r.poster.height },
          preview: { file: r.preview.path, sha256: r.preview.sha256 },
          durationSec: r.durationSec,
          width: r.width,
          height: r.height,
        };
        writeFileSync(join(dir, "hlsdir"), r.hlsDir);
      }
    }
    return out;
  }

  /**
   * Process one image into `dir` (writes `original` and `<width>.webp`). With MEDIA_URL set this runs in the isolated
   * media container (no secrets, no internet); otherwise in-process (development).
   */
  private async processImageAt(src: string, dir: string) {
    if (this.d.config.mediaUrl) {
      const r = await this.remoteMedia("image", src, dir);
      return {
        originalSha256: r.original.sha256 as string,
        mime: r.original.mime as string,
        width: r.original.width as number,
        height: r.original.height as number,
        blurhash: r.blurhash as string,
        variants: r.variants as ImageOut["variants"],
      };
    }
    const r = await processImage(new Uint8Array(readFileSync(src)));
    writeFileSync(join(dir, "original"), r.original.bytes);
    const variants: ImageOut["variants"] = {};
    for (const [w, v] of Object.entries(r.variants)) {
      if (!v) continue;
      writeFileSync(join(dir, `${w}.webp`), v.bytes);
      variants[w] = { file: `${w}.webp`, sha256: v.sha256, width: v.width, height: v.height };
    }
    const o = r.original;
    return { originalSha256: o.sha256, mime: o.mime, width: o.width, height: o.height, blurhash: r.blurhash, variants };
  }

  /** Process one video into `dir`; all returned paths are relative to `dir`. */
  private async processVideoAt(src: string, dir: string) {
    if (this.d.config.mediaUrl) return (await this.remoteMedia("video", src, dir)) as Awaited<ReturnType<typeof processVideo>>;
    const r = await processVideo(src, dir);
    const rel = (p: string) => relative(dir, p);
    return {
      ...r,
      hlsDir: rel(r.hlsDir),
      mp4: { ...r.mp4, path: rel(r.mp4.path) },
      poster: { ...r.poster, path: rel(r.poster.path) },
      preview: { ...r.preview, path: rel(r.preview.path) },
    };
  }

  private async remoteMedia(kind: "image" | "video", src: string, dir: string): Promise<any> {
    const base = this.d.config.workDir;
    const res = await (this.d.fetch ?? fetch)(`${this.d.config.mediaUrl!.replace(/\/+$/, "")}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, input: relative(base, src), outDir: relative(base, dir) }),
      signal: AbortSignal.timeout(kind === "video" ? 24 * 3600_000 : 300_000),
    });
    const body = (await res.json()) as any;
    if (res.status === 422) throw new PolicyError(`media worker refused the ${kind}: ${body.message}`);
    if (!res.ok) throw new Error(`media worker: HTTP ${res.status} ${body.message ?? ""}`);
    return body;
  }

  // ---- 4. IPFS on our own nodes (spec §6 step 3) ----

  private async toIpfs(row: SubmissionRow, media: MediaResult): Promise<IpfsResult> {
    const res: IpfsResult = { images: {}, videos: {} };
    for (const [sha, img] of Object.entries(media.images)) {
      const dir = this.work(row.id, "out", "img", sha);
      const orig = await this.d.ipfs.addFile(new Uint8Array(readFileSync(join(dir, "original"))));
      const variants: Record<string, string> = {};
      for (const [w, v] of Object.entries(img.variants)) {
        variants[w] = (await this.d.ipfs.addFile(new Uint8Array(readFileSync(join(dir, v.file))))).cid;
      }
      res.images[sha] = { cid: orig.cid, variants };
    }
    for (const [sha, vid] of Object.entries(media.videos)) {
      const dir = this.work(row.id, "out", "vid", sha);
      const hlsDir = join(dir, readFileSync(join(dir, "hlsdir"), "utf8"));
      const entries: DirEntry[] = vid.hlsFiles.map((f) => ({
        path: f,
        content: new Uint8Array(readFileSync(join(hlsDir, f))),
      }));
      res.videos[sha] = {
        hlsDir: (await this.d.ipfs.addDirectory(entries)).cid,
        mp4: (await this.d.ipfs.addFile(new Uint8Array(readFileSync(join(dir, vid.mp4.file))))).cid,
        poster: (await this.d.ipfs.addFile(new Uint8Array(readFileSync(join(dir, vid.poster.file))))).cid,
        preview: (await this.d.ipfs.addFile(new Uint8Array(readFileSync(join(dir, vid.preview.file))))).cid,
      };
    }
    return res;
  }

  // ---- 4b. Paid pinning service(s) ----

  private async pin(row: SubmissionRow, steps: Record<string, StepRecord>) {
    const services = this.d.config.pinningServices;
    if (services.length === 0) return { skipped: "no pinning service configured (development only)" };
    const ipfs = steps.ipfs!.result as IpfsResult;
    const cids = [
      ...Object.values(ipfs.images).flatMap((i) => [i.cid, ...Object.values(i.variants)]),
      ...Object.values(ipfs.videos).flatMap((v) => [v.hlsDir, v.mp4, v.poster, v.preview]),
    ];
    const origins = await nodeOrigins(this.d.config.ipfsApis);
    const out: Record<string, unknown[]> = {};
    for (const svc of services) {
      const client = new PinningClient(svc, this.d.fetch);
      const results = [];
      for (const cid of cids)
        results.push({ cid, ...(await client.pin(cid, `azaad:${row.story_id}:${row.version}`, origins)) });
      const failed = results.filter((r) => r.status === "error");
      if (failed.length === results.length && results.length > 0)
        throw new Error(`pinning service ${svc.name} rejected every pin: ${failed[0]!.error}`);
      out[svc.name] = results;
    }
    return out;
  }

  // ---- 5. Torrents for videos (spec §6 step 5) ----

  private async torrent(row: SubmissionRow, steps: Record<string, StepRecord>) {
    const media = steps.media!.result as MediaResult;
    const out: Record<string, { magnet: string; infoHash: string; dirCid: string }> = {};
    for (const [sha, vid] of Object.entries(media.videos)) {
      const dir = this.work(row.id, "out", "vid", sha);
      const name = `azaadawaaz-${row.story_id}-v${row.version}-${sha.slice(0, 12)}`;
      const hlsDir = join(dir, readFileSync(join(dir, "hlsdir"), "utf8"));
      const files = [
        { path: "video.mp4", content: new Uint8Array(readFileSync(join(dir, vid.mp4.file))) },
        ...vid.hlsFiles.map((f) => ({ path: `hls/${f}`, content: new Uint8Array(readFileSync(join(hlsDir, f))) })),
      ];
      // A directory `<name>/…` on IPFS so `<gateway>/ipfs/<cid>/` works as a BEP-19 web seed for the multi-file torrent.
      const dirCid = (
        await this.d.ipfs.addDirectory(files.map((f) => ({ path: `${name}/${f.path}`, content: f.content })))
      ).cid;
      const webSeeds = this.d.config.ipfsGateways.map((g) => `${g.replace(/\/+$/, "")}/ipfs/${dirCid}/`);
      const t = await createVideoTorrent({
        name,
        files,
        webSeeds,
        seedDir: this.d.config.seedDir,
        watchDir: this.d.config.seedWatchDir,
      });
      out[sha] = { magnet: t.magnet, infoHash: t.infoHash, dirCid };
    }
    return out;
  }

  // ---- 6. Manifest (spec §4.2, §6 step 6) ----

  private async manifest(row: SubmissionRow, steps: Record<string, StepRecord>) {
    const body = this.body(row);
    const media = steps.media!.result as MediaResult;
    const ipfs = steps.ipfs!.result as IpfsResult;
    const torrents = (steps.torrent!.result ?? {}) as Record<string, { magnet: string }>;
    const previous = steps.manifest?.result as { publishedAt?: string } | undefined;
    const publishedAt = previous?.publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    const imageFields = (sha: string) => {
      const img = media.images[sha]!;
      const cids = ipfs.images[sha]!;
      return {
        sha256: sha,
        cid: cids.cid,
        width: img.width,
        height: img.height,
        blurhash: img.blurhash,
        ...(Object.keys(cids.variants).length ? { variants: cids.variants } : {}),
      };
    };
    const blocks: Block[] = body.blocks.map((b): Block => {
      switch (b.type) {
        case "text":
          return { type: "text", markdown: lt(b.markdown) };
        case "embed-story":
          return b.version === undefined
            ? { type: "embed-story", storyId: b.storyId }
            : { type: "embed-story", storyId: b.storyId, version: b.version };
        case "image":
          return {
            type: "image",
            items: b.items.map((i) => ({ ...imageFields(i.sha256), ...(i.caption ? { caption: lt(i.caption) } : {}) })),
          };
        case "video": {
          const v = media.videos[b.source.sha256]!;
          const c = ipfs.videos[b.source.sha256]!;
          return {
            type: "video",
            source: { sha256: b.source.sha256 },
            ...(b.title ? { title: lt(b.title) } : {}),
            ...(b.description ? { description: lt(b.description) } : {}),
            hls: `${c.hlsDir}/master.m3u8`,
            mp4: { cid: c.mp4, sha256: v.mp4.sha256 },
            poster: { cid: c.poster, sha256: v.poster.sha256 },
            preview: { cid: c.preview, sha256: v.preview.sha256 },
            ...(torrents[b.source.sha256] ? { magnet: torrents[b.source.sha256]!.magnet } : {}),
            durationSec: v.durationSec,
          };
        }
      }
    });
    const manifest: Manifest = {
      schema: STORY_SCHEMA,
      id: body.id,
      version: body.version,
      supersedes: body.supersedes,
      language: body.language,
      title: lt(body.title),
      summary: lt(body.summary),
      tags: [...body.tags],
      contributor: { pubkey: body.contributor.pubkey, displayName: body.contributor.displayName },
      blocks,
      approval: row.approval,
      publishedAt,
      publisher: hexToNpub(getPublicKey(this.d.config.publisherSecretKey)),
    };
    if (body.cover) manifest.cover = imageFields(body.cover.sha256);
    if (body.location) manifest.location = lt(body.location);

    const v = validateManifest(manifest);
    if (!v.ok) throw new Error(`built manifest is invalid: ${v.errors.join("; ")}`);
    if (!verifyApprovalSignature(manifest, manifest.approval))
      throw new Error("approval does not verify against the manifest");
    const bytes = new TextEncoder().encode(canonicalize(manifest));
    const sha = manifestSha256(manifest);
    writeFileSync(this.work(row.id, "manifest.json"), bytes);
    const { cid } = await this.d.ipfs.addFile(bytes);
    await this.d.db.setSubmissionState(row.id, "publishing", { manifest_sha256: sha, manifest_cid: cid });
    row.manifest_sha256 = sha;
    row.manifest_cid = cid;
    return { cid, sha256: sha, publishedAt };
  }

  private async manifestObj(
    row: SubmissionRow,
    steps: Record<string, StepRecord>,
  ): Promise<{ manifest: Manifest; bytes: Uint8Array; cid: string }> {
    const r = steps.manifest!.result as { cid: string; sha256: string };
    const path = this.work(row.id, "manifest.json");
    const bytes = existsSync(path) ? new Uint8Array(readFileSync(path)) : await this.d.ipfs.cat(r.cid);
    if (!hexEquals(sha256Hex(bytes), r.sha256)) throw new Error("stored manifest does not match its hash");
    const manifest: Manifest = JSON.parse(new TextDecoder().decode(bytes));
    await this.assertManifestSound(row, manifest, r.sha256);
    return { manifest, bytes, cid: r.cid };
  }

  /**
   * Before anything is signed with the publisher's keys, re-derive that the manifest is exactly what a moderator
   * approved for this submission. The job row alone is not trusted: whoever can write the database must not be able
   * to get arbitrary content signed (security review #8).
   */
  private async assertManifestSound(row: SubmissionRow, m: Manifest, sha: string): Promise<void> {
    const v = validateManifest(m);
    if (!v.ok) throw new PolicyError(`manifest invalid: ${v.errors.join("; ")}`);
    if (!hexEquals(manifestSha256(m), sha)) throw new PolicyError("manifest is not canonical");
    if (m.id !== row.story_id || m.version !== row.version || m.supersedes !== (row.supersedes ?? null))
      throw new PolicyError("manifest id/version/supersedes differ from the submission");
    if (npubToHex(m.contributor.pubkey) !== row.contributor) throw new PolicyError("manifest contributor differs");
    if (canonicalize(m.approval) !== canonicalize(row.approval)) throw new PolicyError("manifest approval differs");
    if (!hexEquals(approvalBodySha256(m), row.approval_body_sha256))
      throw new PolicyError("manifest content differs from what the moderator approved");
    if (!verifyApprovalSignature(m, m.approval)) throw new PolicyError("approval signature does not verify");
    const lists = await this.lists();
    if (!wasModeratorAt(lists, m.approval.moderator, Math.floor(Date.parse(m.approval.approvedAt) / 1000)))
      throw new PolicyError("approver was not a moderator at approval time");
    if (npubToHex(m.publisher) !== getPublicKey(this.d.config.publisherSecretKey))
      throw new PolicyError("manifest names a different publisher");
  }

  // ---- 7. Nostr (spec §6 step 7) ----

  private async nostr(row: SubmissionRow, steps: Record<string, StepRecord>) {
    const { manifest, cid } = await this.manifestObj(row, steps);
    const prev = steps.nostr?.result as { event?: Event } | undefined;
    const event =
      prev?.event ?? createStoryEvent({ manifest, manifestCid: cid, secretKey: this.d.config.publisherSecretKey });
    const relays = publishRelays(await this.lists(), this.d.config.bootstrapRelays);
    const results = await this.d.relays.publish(relays, event);
    const ok = results.filter((r) => r.ok).length;
    const required = Math.min(this.d.config.requiredRelaySuccesses, relays.length);
    if (ok < required) {
      // Keep the signed event so the retry republishes the same one.
      steps.nostr = {
        done: false,
        result: { event },
        attempts: steps.nostr?.attempts ?? 0,
        at: new Date().toISOString(),
      };
      await this.d.db.saveStep(row.id, "nostr", steps.nostr);
      throw new Error(
        `story event accepted by ${ok}/${relays.length} relays, need ${required}: ${JSON.stringify(results)}`,
      );
    }
    await this.d.db.setSubmissionState(row.id, "published", { published_at: new Date() });
    return { event, relays: results };
  }

  // ---- 8. On-chain receipts (spec §6 step 8; decision D7) ----

  private async chain(key: string, row: SubmissionRow, steps: Record<string, StepRecord>) {
    const chain = this.d.config.chains.find((c) => c.key === key);
    if (!chain) throw new Error(`chain ${key} is not configured`);
    const r = steps.manifest!.result as { cid: string; sha256: string };
    await this.manifestObj(row, steps); // re-verifies before anything is signed
    const stepName = `chain:${key}`;
    const pendingTx = (steps[stepName]?.result as { pendingTx?: `0x${string}` } | undefined)?.pendingTx;
    return writeReceipt({
      chain,
      privateKey: this.d.config.publisherEvmKey,
      storyId: row.story_id,
      version: row.version,
      manifestSha256: r.sha256,
      manifestCid: r.cid,
      pendingTx,
      onSent: async (tx) => {
        await this.d.db.saveStep(row.id, stepName, {
          done: false,
          result: { pendingTx: tx },
          attempts: steps[stepName]?.attempts ?? 0,
          at: new Date().toISOString(),
        });
      },
    });
  }

  // ---- Arweave (spec §6 step 4), after publication ----

  private async toArweave(row: SubmissionRow, steps: Record<string, StepRecord>) {
    const media = steps.media!.result as MediaResult;
    const ipfs = steps.ipfs!.result as IpfsResult;
    const prev = (steps.arweave?.result ?? {}) as { tx?: Record<string, string> };
    const tx: Record<string, string> = { ...(prev.tx ?? {}) };
    const save = () =>
      this.d.db.saveStep(row.id, "arweave", {
        done: false,
        result: { tx },
        attempts: steps.arweave?.attempts ?? 0,
        at: new Date().toISOString(),
      });
    const put = async (sha: string, getBytes: () => Promise<Uint8Array>, contentType: string) => {
      if (tx[sha]) return;
      const data = await getBytes();
      if (!hexEquals(sha256Hex(data), sha)) throw new Error(`bytes for ${sha} do not match`);
      tx[sha] = await this.d.arweave.upload({ sha256: sha, data, contentType, storyId: row.story_id });
      await save();
    };
    const fromIpfs = (cid: string) => () => this.d.ipfs.cat(cid);

    for (const [sha, img] of Object.entries(media.images)) {
      await put(sha, fromIpfs(ipfs.images[sha]!.cid), img.mime);
      for (const [w, v] of Object.entries(img.variants))
        await put(v.sha256, fromIpfs(ipfs.images[sha]!.variants[w]!), "image/webp");
    }
    for (const [sha, vid] of Object.entries(media.videos)) {
      await put(vid.poster.sha256, fromIpfs(ipfs.videos[sha]!.poster), "image/jpeg");
      const size = (await this.d.ipfs.cat(ipfs.videos[sha]!.mp4)).length;
      if (this.d.config.arweaveMaxVideoBytes > 0 && size <= this.d.config.arweaveMaxVideoBytes) {
        await put(vid.mp4.sha256, fromIpfs(ipfs.videos[sha]!.mp4), "video/mp4");
      }
    }
    const { bytes } = await this.manifestObj(row, steps);
    const msha = (steps.manifest!.result as { sha256: string }).sha256;
    await put(msha, async () => bytes, "application/json");
    return { tx };
  }

  // ---- Storage receipt (decision D3) ----

  private async storageReceipt(row: SubmissionRow, steps: Record<string, StepRecord>) {
    const tx = (steps.arweave!.result as { tx: Record<string, string> }).tx;
    const msha = (steps.manifest!.result as { sha256: string }).sha256;
    const prev = steps["storage-receipt"]?.result as { event?: Event } | undefined;
    const event =
      prev?.event ??
      createStorageReceiptEvent(
        { storyId: row.story_id, version: row.version, manifestSha256: msha, arweave: tx },
        this.d.config.publisherSecretKey,
      );
    const relays = publishRelays(await this.lists(), this.d.config.bootstrapRelays);
    const results = await this.d.relays.publish(relays, event);
    if (!results.some((r) => r.ok))
      throw new Error(`no relay accepted the storage receipt: ${JSON.stringify(results)}`);
    return { event, relays: results };
  }

  // ---- Finalize: pin status, clean up staging (spec §5.2) ----

  private async finalize(row: SubmissionRow, steps: Record<string, StepRecord>) {
    const pins = steps.pin?.result as
      Record<string, { requestid?: string; cid: string }[]> | { skipped: string } | undefined;
    const pinStatus: Record<string, Record<string, string>> = {};
    if (pins && !("skipped" in pins)) {
      for (const svc of this.d.config.pinningServices) {
        const client = new PinningClient(svc, this.d.fetch);
        pinStatus[svc.name] = {};
        for (const p of (pins as Record<string, { requestid?: string; cid: string }[]>)[svc.name] ?? []) {
          if (p.requestid) pinStatus[svc.name]![p.cid] = (await client.status(p.requestid)).status;
        }
      }
    }
    // Staging is normally mounted read-only here; the API's retention job deletes it then (spec §5.2).
    let stagingDeleted = true;
    try {
      rmSync(join(this.d.config.stagingDir, row.id), { recursive: true, force: true });
    } catch {
      stagingDeleted = false;
    }
    rmSync(this.work(row.id), { recursive: true, force: true });
    await this.d.db.finishJob(row.id);
    return { pinStatus, stagingDeleted };
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}
