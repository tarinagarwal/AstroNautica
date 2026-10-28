/**
 * Verified media on disk for display (spec §8): images and posters are fetched by CID (block-verified) or by SHA-256
 * and written to the cache only after verification; the image view loads that file. MP4 fallbacks are downloaded
 * natively and kept only if the bytes hash to the manifest's sha256. Saved (offline) stories keep their own copies.
 */
import { sourcesFor, type SourceReport } from "@azaadawaaz/core";
import type { Cover, FileRef, ImageItem } from "@azaadawaaz/schema";
import { joinPath, type FileSystem, type Http } from "../platform/types";
import type { GatewayClient } from "./gateways";

export type ImageSize = "480" | "960" | "1600";

export class MediaStore {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly dir: string;
  private ready?: Promise<void>;
  /** Directories of saved stories, checked before the network (sha256 → path). */
  private offlineLookup?: (key: string) => Promise<string | undefined>;

  constructor(
    private readonly fs: FileSystem,
    private readonly http: Http,
    private readonly gateways: GatewayClient,
  ) {
    this.dir = joinPath(fs.paths.cache, "media");
  }

  setOfflineLookup(fn: (key: string) => Promise<string | undefined>): void {
    this.offlineLookup = fn;
  }

  private async cached(key: string, load: () => Promise<Uint8Array>): Promise<string> {
    await (this.ready ??= this.fs.mkdirs(this.dir));
    const path = joinPath(this.dir, key);
    let p = this.pending.get(key);
    if (!p) {
      p = (async () => {
        const offline = await this.offlineLookup?.(key);
        if (offline) return offline;
        const st = await this.fs.stat(path);
        if (st.exists && st.size > 0) return path;
        const bytes = await load();
        await this.fs.writeBytes(path + ".part", bytes);
        await this.fs.move(path + ".part", path);
        return path;
      })();
      this.pending.set(key, p);
      p.catch(() => this.pending.delete(key));
    }
    return p;
  }

  /** The best variant for the width (block-verified by CID), falling back to the original (verified by sha256). */
  async image(item: Pick<ImageItem, "sha256" | "cid" | "variants"> | Cover, size: ImageSize = "960"): Promise<string> {
    const saved = await this.offlineLookup?.(item.sha256);
    if (saved) return saved;
    const order: ImageSize[] = size === "480" ? ["480", "960", "1600"] : size === "960" ? ["960", "1600", "480"] : ["1600", "960"];
    const variant = order.map((s) => item.variants?.[s]).find(Boolean);
    if (variant) {
      return this.cached(`cid-${variant}`, () => this.gateways.fetchByCid(variant, 25 * 1024 * 1024)).catch(() =>
        this.original(item),
      );
    }
    return this.original(item);
  }

  original(item: { sha256: string; cid?: string }): Promise<string> {
    return this.cached(item.sha256, () =>
      this.gateways.fetchBySha({ sha256: item.sha256, cid: item.cid }, { maxBytes: 25 * 1024 * 1024 }),
    );
  }

  file(ref: FileRef, maxBytes = 25 * 1024 * 1024): Promise<string> {
    return this.cached(ref.sha256, () => this.gateways.fetchBySha({ sha256: ref.sha256, cid: ref.cid }, { maxBytes }));
  }

  /**
   * Download a large file (the MP4 fallback) by trying each gateway in turn; the native downloader deletes the file
   * and fails if the bytes don't hash to `ref.sha256`. Mismatching gateways are flagged.
   */
  async video(ref: FileRef, onProgress?: (bytes: number, total: number) => void, signal?: AbortSignal): Promise<string> {
    const offline = await this.offlineLookup?.(ref.sha256);
    if (offline) return offline;
    await (this.ready ??= this.fs.mkdirs(this.dir));
    const dest = joinPath(this.dir, ref.sha256);
    const st = await this.fs.stat(dest);
    if (st.exists && (await this.fs.sha256(dest)) === ref.sha256) return dest;
    let last: unknown = new Error("no gateway configured");
    for (const src of sourcesFor({ cid: ref.cid }, this.gateways.list(), this.gateways.scoreboard)) {
      const t0 = Date.now();
      try {
        await this.http.download({ url: src.url, dest, sha256: ref.sha256, onProgress, signal, timeoutMs: 60_000 });
        this.gateways.scoreboard.record(src.base, { url: src.url, ok: true, ms: Date.now() - t0 });
        return dest;
      } catch (e) {
        last = e;
        if (signal?.aborted) throw e;
        const reason: SourceReport["reason"] = (e as { kind?: string }).kind === "mismatch" ? "mismatch" : "network";
        this.gateways.scoreboard.record(src.base, { url: src.url, ok: false, reason, ms: Date.now() - t0 });
        this.gateways.record(src.base, reason);
      }
    }
    throw last;
  }

  async clearCache(): Promise<void> {
    await this.fs.remove(this.dir).catch(() => undefined);
    this.ready = undefined;
    this.pending.clear();
  }
}
