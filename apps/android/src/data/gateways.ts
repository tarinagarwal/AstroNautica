/**
 * Every published file the app shows comes through here: raced across gateways with a shared scoreboard (own
 * gateways first, then pinning services, then public ones), verified by SHA-256 (core `fetchVerified`) or by CID
 * (trustless blocks). Gateways that served wrong bytes are flagged and listed in the Verify panel.
 */
import { GatewayScoreboard, fetchVerified, sourcesFor, type FetchLike, type SourceReport } from "@azaadawaaz/core";
import type { GatewayEntry } from "@azaadawaaz/core";
import type { Http } from "../platform/types";
import { fetchFileByCid, fetchIpfsPath, type BlockReport, type BlockSource } from "./ipfs";

/** Adapts the platform HTTP client to the `fetch` shape core expects (only what core reads). */
export function fetchLikeFrom(http: Http, maxBytes = 64 * 1024 * 1024): FetchLike {
  return async (url, init) => {
    const res = await http.request({ url, signal: init?.signal, maxBytes, timeoutMs: 30_000 });
    const headers = new Map(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const body = res.body;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      url: res.url,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => new TextDecoder().decode(body),
      json: async () => JSON.parse(new TextDecoder().decode(body)),
    } as unknown as Response;
  };
}

export interface ShaRef {
  cid?: string;
  sha256: string;
  arweave?: string;
}

const RANK = { own: 0, pinning: 1, public: 2 } as const;

export class GatewayClient {
  readonly scoreboard = new GatewayScoreboard();
  private gateways: GatewayEntry[] = [];
  private readonly flagged = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly http: Http) {}

  setGateways(g: GatewayEntry[]): void {
    this.gateways = g;
  }

  list(): GatewayEntry[] {
    return this.gateways;
  }

  ipfsBases(): string[] {
    return this.scoreboard.order(
      this.gateways
        .filter((g) => g.network === "ipfs")
        .sort((a, b) => RANK[a.operator] - RANK[b.operator])
        .map((g) => g.url.replace(/\/+$/, "")),
      (x) => x,
    );
  }

  onFlagged(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Gateways that served bytes not matching the expected hash in this session. */
  flaggedSources(): string[] {
    return [...this.flagged.keys()];
  }

  /** Note a source's result; a hash mismatch flags the gateway for the Verify panel. */
  record(base: string, reason: SourceReport["reason"]): void {
    if (reason !== "mismatch") return;
    this.flagged.set(base, (this.flagged.get(base) ?? 0) + 1);
    this.listeners.forEach((l) => l());
  }

  private baseOf(url: string): string {
    const g = this.gateways.find((x) => url.startsWith(x.url.replace(/\/+$/, "")));
    return g ? g.url.replace(/\/+$/, "") : new URL(url).origin;
  }

  /** A file by SHA-256 from IPFS gateways (own, pinning, public) and then Arweave gateways. */
  fetchBySha(ref: ShaRef, opts: { maxBytes?: number; timeoutMs?: number; onReport?: (r: SourceReport) => void } = {}) {
    const sources = sourcesFor({ cid: ref.cid, arweave: ref.arweave }, this.gateways, this.scoreboard);
    return fetchVerified({
      sources,
      sha256: ref.sha256,
      scoreboard: this.scoreboard,
      fetch: fetchLikeFrom(this.http, opts.maxBytes),
      maxBytes: opts.maxBytes,
      timeoutMs: opts.timeoutMs,
      onReport: (r) => {
        this.record(this.baseOf(r.url), r.reason);
        opts.onReport?.(r);
      },
    });
  }

  blockSource(extra: { noCache?: boolean; onReport?: (r: BlockReport) => void } = {}): BlockSource {
    return {
      gateways: () => this.ipfsBases(),
      fetch: async (url, signal) => {
        const r = await this.http.request({
          url,
          signal,
          headers: { Accept: "application/vnd.ipld.raw" },
          maxBytes: 4 * 1024 * 1024,
          timeoutMs: 15_000,
        });
        return { status: r.status, body: r.body };
      },
      noCache: extra.noCache,
      onReport: (r) => {
        this.scoreboard.record(r.base, { url: r.url, ok: r.ok, reason: r.reason, ms: r.ms });
        this.record(r.base, r.reason);
        extra.onReport?.(r);
      },
    };
  }

  fetchByCid(cid: string, maxBytes?: number): Promise<Uint8Array> {
    return fetchFileByCid(cid, this.blockSource(), maxBytes);
  }

  fetchByPath(path: string, maxBytes?: number): Promise<Uint8Array> {
    return fetchIpfsPath(path, this.blockSource(), maxBytes);
  }

  ipfsLinks(cid: string): string[] {
    return this.gateways.filter((g) => g.network === "ipfs").map((g) => `${g.url.replace(/\/+$/, "")}/ipfs/${cid}`);
  }

  arweaveLinks(tx: string): string[] {
    return this.gateways.filter((g) => g.network === "arweave").map((g) => `${g.url.replace(/\/+$/, "")}/${tx}`);
  }
}
