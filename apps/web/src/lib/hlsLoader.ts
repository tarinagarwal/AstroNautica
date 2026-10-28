/**
 * An hls.js loader that fetches every playlist and segment through the IPFS gateways in order, with failover, and
 * verifies each block against its CID (the content address is the integrity check). Playlists reference segments by
 * relative paths, which resolve under the virtual base `https://ipfs.invalid/ipfs/<root cid>/…`.
 */
import type { Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from "hls.js";
import { fetchByPath } from "./gateways.js";

export const VIRTUAL_BASE = "https://ipfs.invalid/ipfs/";

export function virtualUrl(ipfsPath: string): string {
  return VIRTUAL_BASE + ipfsPath.replace(/^\/?ipfs\//, "");
}

function newStats(): LoaderStats {
  const now = performance.now();
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: now, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

export type PathFetcher = (path: string) => Promise<Uint8Array>;

export function makeVerifiedLoader(fetchPath: PathFetcher = (p) => fetchByPath(p, 64 * 1024 * 1024)) {
  return class VerifiedLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = newStats();
    private aborted = false;

    constructor(_config: unknown) {}

    load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context;
      this.stats = newStats();
      const stats = this.stats;
      if (!context.url.startsWith(VIRTUAL_BASE)) {
        callbacks.onError({ code: 400, text: "only IPFS paths are allowed" }, context, null, stats);
        return;
      }
      const path = decodeURI(context.url.slice(VIRTUAL_BASE.length).split(/[?#]/)[0]!);
      fetchPath(path).then(
        (bytes) => {
          if (this.aborted) return;
          let data = bytes;
          if (context.rangeEnd || context.rangeStart)
            data = bytes.subarray(context.rangeStart ?? 0, context.rangeEnd || undefined);
          stats.loading.first = stats.loading.end = performance.now();
          stats.loaded = stats.total = data.length;
          const payload =
            context.responseType === "arraybuffer"
              ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
              : new TextDecoder().decode(data);
          callbacks.onSuccess({ url: context.url, data: payload, code: 200 }, stats, context, null);
        },
        (e: unknown) => {
          if (this.aborted) return;
          stats.loading.end = performance.now();
          callbacks.onError({ code: 502, text: e instanceof Error ? e.message : String(e) }, context, null, stats);
        },
      );
    }

    abort(): void {
      this.aborted = true;
      this.stats.aborted = true;
    }

    destroy(): void {
      this.abort();
      this.context = null;
    }
  };
}
