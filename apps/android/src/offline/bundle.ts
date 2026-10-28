/**
 * Offline story bundles (spec §8.2 "offline sharing"): a story travels phone to phone as a zip holding the
 * publisher-signed story event, the signed list events needed to check it, the exact manifest bytes and the media
 * files named by their SHA-256. Nothing in a bundle is trusted: on import every signature is checked against the
 * pinned owner key (core `buildEffectiveLists`, `selectStories`, `verifyManifest`) and every file is hashed, before
 * anything is shown. The index file is only a table of contents.
 *
 *   azaad-bundle.json   { schema, createdAt, storyId, version, manifestSha256, files: [{ path, sha256, size }] }
 *   events.json         { story: Event, lists: Event[], storage: Event[] }
 *   manifest.json       the manifest bytes exactly as published (canonical JSON)
 *   media/<sha256>      media files (originals of images, poster, preview, MP4 fallback)
 */
import {
  buildEffectiveLists,
  parseStorageReceipt,
  selectStories,
  verifyManifest,
  type EffectiveLists,
  type Event,
  type ManifestCheck,
  type StorageReceipt,
  type StoryRef,
} from "@azaadawaaz/core";
import { isSha256Hex, type Manifest } from "@azaadawaaz/schema";
import { joinPath, type FileSystem } from "../platform/types";
import { fromUtf8, utf8 } from "../util/bytes";

export const BUNDLE_SCHEMA = "azaadawaaz/bundle@1";
export const BUNDLE_MIME = "application/zip";
export const BUNDLE_EXT = ".azaad.zip";

export interface BundleIndex {
  schema: typeof BUNDLE_SCHEMA;
  createdAt: number;
  storyId: string;
  version: number;
  manifestSha256: string;
  files: { path: string; sha256: string; size: number }[];
}

export interface BundleEvents {
  story: Event;
  lists: Event[];
  storage: Event[];
}

export type MediaKind = "image" | "cover" | "poster" | "preview" | "video";

/** Every file a manifest references by SHA-256, with what it is. Video originals are not published (only `source`). */
export function manifestFiles(m: Manifest): Map<string, { kind: MediaKind; cid?: string }> {
  const out = new Map<string, { kind: MediaKind; cid?: string }>();
  if (m.cover) out.set(m.cover.sha256, { kind: "cover", cid: m.cover.cid });
  for (const b of m.blocks) {
    if (b.type === "image") for (const i of b.items) out.set(i.sha256, { kind: "image", cid: i.cid });
    if (b.type === "video") {
      out.set(b.poster.sha256, { kind: "poster", cid: b.poster.cid });
      if (b.preview) out.set(b.preview.sha256, { kind: "preview", cid: b.preview.cid });
      out.set(b.mp4.sha256, { kind: "video", cid: b.mp4.cid });
    }
  }
  return out;
}

export interface ExportInput {
  ref: StoryRef;
  manifestBytes: Uint8Array;
  manifest: Manifest;
  lists: EffectiveLists;
  storage: Event[];
  /** Resolve a referenced file to a local path (download + verify); undefined to leave it out. */
  fetchFile(sha256: string, info: { kind: MediaKind; cid?: string }): Promise<string | undefined>;
  includeVideo: boolean;
}

/** Build a bundle zip at `out`. Returns the index (what was included). */
export async function exportBundle(fs: FileSystem, input: ExportInput, workDir: string, out: string): Promise<BundleIndex> {
  await fs.remove(workDir).catch(() => undefined);
  await fs.mkdirs(joinPath(workDir, "media"));
  const files: BundleIndex["files"] = [];
  for (const [sha, info] of manifestFiles(input.manifest)) {
    if (info.kind === "video" && !input.includeVideo) continue;
    const src = await input.fetchFile(sha, info);
    if (!src) continue;
    const path = `media/${sha}`;
    await fs.copy(src, joinPath(workDir, path));
    const actual = await fs.sha256(joinPath(workDir, path));
    if (actual !== sha) throw new Error(`file ${sha.slice(0, 12)}… changed while exporting`);
    files.push({ path, sha256: sha, size: (await fs.stat(joinPath(workDir, path))).size });
  }
  const events: BundleEvents = { story: input.ref.event, lists: input.lists.sourceEvents, storage: input.storage };
  const index: BundleIndex = {
    schema: BUNDLE_SCHEMA,
    createdAt: Math.floor(Date.now() / 1000),
    storyId: input.ref.storyId,
    version: input.ref.version,
    manifestSha256: input.ref.manifestSha256,
    files,
  };
  await fs.writeBytes(joinPath(workDir, "manifest.json"), input.manifestBytes);
  await fs.writeText(joinPath(workDir, "events.json"), JSON.stringify(events));
  await fs.writeText(joinPath(workDir, "azaad-bundle.json"), JSON.stringify(index, null, 1));
  await fs.remove(out).catch(() => undefined);
  await fs.zipDir(workDir, out);
  await fs.remove(workDir).catch(() => undefined);
  return index;
}

export class BundleError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

export interface VerifiedBundle {
  ref: StoryRef;
  manifest: Manifest;
  manifestBytes: Uint8Array;
  check: ManifestCheck;
  /** Directory holding media/<sha256>, every file already verified. */
  dir: string;
  /** sha256 → local path for each verified file. */
  media: Map<string, string>;
  /** Referenced files not in the bundle. */
  missing: string[];
  storage: StorageReceipt[];
  storageEvents: Event[];
  /** List events from the bundle that chain to the pinned owner key (to merge into the app's lists). */
  listEvents: Event[];
  /** The story is on the effective unlisted list (shown with the honest notice). */
  unlisted: boolean;
}

const LIMITS = { maxBytes: 8 * 1024 * 1024 * 1024, maxEntries: 4000 };
const JSON_MAX = 8 * 1024 * 1024;

async function readJsonFile<T>(fs: FileSystem, path: string): Promise<T> {
  const st = await fs.stat(path);
  if (!st.exists || st.isDir) throw new BundleError("bundle.error.missingPart", `${path.split("/").pop()} is missing`);
  if (st.size > JSON_MAX) throw new BundleError("bundle.error.tooLarge", `${path.split("/").pop()} is too large`);
  try {
    return JSON.parse(fromUtf8(await fs.readBytes(path))) as T;
  } catch {
    throw new BundleError("bundle.error.malformed", `${path.split("/").pop()} is not valid JSON`);
  }
}

/**
 * Unpack and verify a bundle. Throws BundleError unless the story event is signed by a valid publisher key, the
 * manifest passes every check, and every file is referenced by the manifest and hashes to its name.
 */
export async function importBundle(
  fs: FileSystem,
  zipPath: string,
  destDir: string,
  trust: { ownerPubkey: string; knownListEvents: Event[]; now?: number },
): Promise<VerifiedBundle> {
  await fs.remove(destDir).catch(() => undefined);
  await fs.mkdirs(destDir);
  let entries;
  try {
    entries = await fs.unzip(zipPath, destDir, LIMITS);
  } catch (e) {
    throw new BundleError("bundle.error.unzip", e instanceof Error ? e.message : String(e));
  }
  const allowed = /^(azaad-bundle\.json|events\.json|manifest\.json|media\/[0-9a-f]{64})$/;
  const strange = entries.filter((e) => !allowed.test(e.name) && !e.name.endsWith("/") && e.name !== "media");
  if (strange.length) throw new BundleError("bundle.error.unexpected", `unexpected files: ${strange.map((e) => e.name).join(", ")}`);

  const index = await readJsonFile<BundleIndex>(fs, joinPath(destDir, "azaad-bundle.json"));
  if (index?.schema !== BUNDLE_SCHEMA) throw new BundleError("bundle.error.schema", "not an AzaadAwaaz bundle");
  const events = await readJsonFile<BundleEvents>(fs, joinPath(destDir, "events.json"));
  if (!events?.story || !Array.isArray(events.lists))
    throw new BundleError("bundle.error.malformed", "events.json is incomplete");
  const manifestPath = joinPath(destDir, "manifest.json");
  const mst = await fs.stat(manifestPath);
  if (!mst.exists || mst.size > JSON_MAX) throw new BundleError("bundle.error.missingPart", "manifest.json is missing");
  const manifestBytes = await fs.readBytes(manifestPath);

  // Signatures: only list events that chain to the pinned owner key count; the story must be signed by a publisher
  // key valid at its time.
  const lists = buildEffectiveLists(trust.ownerPubkey, [...trust.knownListEvents, ...events.lists], { now: trust.now });
  const [ref] = selectStories([events.story], lists, { includeUnlisted: true });
  if (!ref) throw new BundleError("bundle.error.signature", "the story is not signed by a valid publisher key");
  if (ref.storyId !== index.storyId || ref.version !== index.version)
    throw new BundleError("bundle.error.mismatch", "the bundle index does not match the story event");

  const check = verifyManifest(manifestBytes, ref, lists);
  if (!check.ok || !check.manifest) throw new BundleError("bundle.error.manifest", check.errors.join("; ") || "manifest check failed");

  // Files: each must be referenced by the manifest and hash to its name.
  const expected = manifestFiles(check.manifest);
  const media = new Map<string, string>();
  const mediaDir = joinPath(destDir, "media");
  const names = (await fs.stat(mediaDir)).exists ? await fs.list(mediaDir) : [];
  for (const name of names) {
    if (!isSha256Hex(name) || !expected.has(name))
      throw new BundleError("bundle.error.unexpected", `file ${name} is not part of this story`);
    const path = joinPath(mediaDir, name);
    if ((await fs.sha256(path)) !== name) throw new BundleError("bundle.error.hash", `file ${name.slice(0, 12)}… is altered`);
    media.set(name, path);
  }
  const missing = [...expected.keys()].filter((k) => !media.has(k));

  const storageEvents = (events.storage ?? []).filter((e) => {
    const r = parseStorageReceipt(e, lists);
    return r !== null && r.storyId === ref.storyId;
  });
  const storage = storageEvents.map((e) => parseStorageReceipt(e, lists)!);
  const listEvents = lists.sourceEvents.filter((e) => events.lists.some((x) => x.id === e.id));
  return {
    ref,
    manifest: check.manifest,
    manifestBytes,
    check,
    dir: destDir,
    media,
    missing,
    storage,
    storageEvents,
    listEvents,
    unlisted: lists.unlisted.has(ref.storyId),
  };
}

export const encodeJson = (v: unknown) => utf8(JSON.stringify(v));
