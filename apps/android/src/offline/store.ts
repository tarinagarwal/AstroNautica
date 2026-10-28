/**
 * Saved stories (spec §8.2 "save for offline"): the story event, the manifest bytes, storage receipts and media
 * files are kept in app storage. Files are verified by SHA-256 when saved; the manifest is re-verified against the
 * current lists every time a saved story is opened, and images are re-hashed before display.
 */
import { selectStories, verifyManifest, type EffectiveLists, type Event, type StoryRef } from "@azaadawaaz/core";
import type { Manifest } from "@azaadawaaz/schema";
import type { JsonStore } from "../platform/kv";
import { joinPath, type FileSystem } from "../platform/types";
import { manifestFiles, type MediaKind, type VerifiedBundle } from "./bundle";

export interface SavedEntry {
  storyId: string;
  version: number;
  title: string;
  manifestSha256: string;
  savedAt: number;
  /** sha256s of the files kept on the device. */
  files: string[];
  bytes: number;
  /** "saved" from the network, or "bundle" when received from another phone. */
  source: "saved" | "bundle";
}

export class OfflineStore {
  private index: SavedEntry[] | null = null;
  private readonly root: string;

  constructor(
    private readonly fs: FileSystem,
    private readonly kv: JsonStore,
  ) {
    this.root = joinPath(fs.paths.files, "offline");
  }

  dirOf(storyId: string): string {
    return joinPath(this.root, storyId);
  }

  async list(): Promise<SavedEntry[]> {
    this.index ??= (await this.kv.get<SavedEntry[]>("offline:index")) ?? [];
    return [...this.index].sort((a, b) => b.savedAt - a.savedAt);
  }

  private async writeIndex(entries: SavedEntry[]): Promise<void> {
    this.index = entries;
    await this.kv.set("offline:index", entries);
  }

  async isSaved(storyId: string): Promise<boolean> {
    return (await this.list()).some((e) => e.storyId === storyId);
  }

  /** Path of a saved file by sha256, if any saved story holds it. */
  async lookup(sha256: string): Promise<string | undefined> {
    for (const e of await this.list()) {
      if (e.files.includes(sha256)) {
        const p = joinPath(this.dirOf(e.storyId), "media", sha256);
        if ((await this.fs.stat(p)).exists) return p;
      }
    }
    return undefined;
  }

  /** Save a story from the network: `fetchFile` downloads and verifies each file. */
  async save(args: {
    ref: StoryRef;
    manifest: Manifest;
    manifestBytes: Uint8Array;
    storageEvents: Event[];
    includeVideo: boolean;
    fetchFile(sha256: string, info: { kind: MediaKind; cid?: string }): Promise<string | undefined>;
  }): Promise<SavedEntry> {
    const dir = this.dirOf(args.ref.storyId);
    await this.fs.remove(dir).catch(() => undefined);
    await this.fs.mkdirs(joinPath(dir, "media"));
    const files: string[] = [];
    let bytes = 0;
    for (const [sha, info] of manifestFiles(args.manifest)) {
      if (info.kind === "video" && !args.includeVideo) continue;
      const src = await args.fetchFile(sha, info);
      if (!src) continue;
      const dest = joinPath(dir, "media", sha);
      await this.fs.copy(src, dest);
      if ((await this.fs.sha256(dest)) !== sha) {
        await this.fs.remove(dest);
        throw new Error(`file ${sha.slice(0, 12)}… failed verification`);
      }
      files.push(sha);
      bytes += (await this.fs.stat(dest)).size;
    }
    await this.writeMeta(dir, args.ref.event, args.manifestBytes, args.storageEvents);
    return this.record({
      storyId: args.ref.storyId,
      version: args.ref.version,
      title: args.ref.title,
      manifestSha256: args.ref.manifestSha256,
      savedAt: Date.now(),
      files,
      bytes: bytes + args.manifestBytes.length,
      source: "saved",
    });
  }

  /** Keep a verified bundle received from another phone (its files are already verified). */
  async saveBundle(b: VerifiedBundle): Promise<SavedEntry> {
    const dir = this.dirOf(b.ref.storyId);
    await this.fs.remove(dir).catch(() => undefined);
    await this.fs.mkdirs(joinPath(dir, "media"));
    let bytes = b.manifestBytes.length;
    for (const [sha, path] of b.media) {
      await this.fs.move(path, joinPath(dir, "media", sha));
      bytes += (await this.fs.stat(joinPath(dir, "media", sha))).size;
    }
    await this.writeMeta(dir, b.ref.event, b.manifestBytes, b.storageEvents);
    await this.fs.remove(b.dir).catch(() => undefined);
    return this.record({
      storyId: b.ref.storyId,
      version: b.ref.version,
      title: b.ref.title,
      manifestSha256: b.ref.manifestSha256,
      savedAt: Date.now(),
      files: [...b.media.keys()],
      bytes,
      source: "bundle",
    });
  }

  private async writeMeta(dir: string, story: Event, manifestBytes: Uint8Array, storage: Event[]): Promise<void> {
    await this.fs.writeBytes(joinPath(dir, "manifest.json"), manifestBytes);
    await this.fs.writeText(joinPath(dir, "story.json"), JSON.stringify(story));
    await this.fs.writeText(joinPath(dir, "storage.json"), JSON.stringify(storage));
  }

  private async record(entry: SavedEntry): Promise<SavedEntry> {
    const rest = (await this.list()).filter((e) => e.storyId !== entry.storyId);
    await this.writeIndex([entry, ...rest]);
    return entry;
  }

  /** Load a saved story and re-verify its manifest against the current lists. */
  async open(storyId: string, lists: Pick<EffectiveLists, "moderators" | "owner" | "serviceKeys" | "unlisted">) {
    const dir = this.dirOf(storyId);
    const story = JSON.parse(await this.fs.readText(joinPath(dir, "story.json"))) as Event;
    const [ref] = selectStories([story], lists, { includeUnlisted: true });
    if (!ref) throw new Error("saved story is not signed by a valid publisher key");
    const manifestBytes = await this.fs.readBytes(joinPath(dir, "manifest.json"));
    const check = verifyManifest(manifestBytes, ref, lists);
    const storage = JSON.parse(await this.fs.readText(joinPath(dir, "storage.json")).catch(() => "[]")) as Event[];
    return { ref, manifestBytes, check, storage };
  }

  async remove(storyId: string): Promise<void> {
    await this.fs.remove(this.dirOf(storyId)).catch(() => undefined);
    await this.writeIndex((await this.list()).filter((e) => e.storyId !== storyId));
  }
}
