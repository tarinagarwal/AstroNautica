/**
 * Every file the app shows comes through here: raced across gateways with a shared scoreboard, verified by SHA-256
 * (core `fetchVerified`) or by CID (trustless blocks, `ipfs.ts`). Gateways that served wrong bytes are flagged and
 * shown in the Verify panel.
 */
import { GatewayScoreboard, fetchVerified, sourcesFor, type SourceReport } from "@core/fetch.js";
import type { GatewayEntry } from "@core/lists.js";
import { fetchFileByCid, fetchIpfsPath, type BlockSource } from "./ipfs.js";

export const scoreboard = new GatewayScoreboard();

let gateways: GatewayEntry[] = [];
const flagged = new Map<string, number>();
const listeners = new Set<() => void>();
let fetchImpl: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;

export function setGateways(g: GatewayEntry[]): void {
  gateways = g;
}

export function getGateways(): GatewayEntry[] {
  return gateways;
}

/** Override fetch (tests). */
export function setFetch(f: typeof fetchImpl): void {
  fetchImpl = f;
}

export const gatewayFetch = (url: string, init?: RequestInit) => (fetchImpl ?? globalThis.fetch)(url, init);
const doFetch = gatewayFetch;

export function onFlagged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Gateways that served bytes not matching the expected hash during this session. */
export function flaggedSources(): string[] {
  return [...flagged.keys()];
}

function record(base: string, r: SourceReport): void {
  if (r.reason === "mismatch") {
    flagged.set(base, (flagged.get(base) ?? 0) + 1);
    listeners.forEach((l) => l());
  }
}

/** Base URL of a source URL produced by `sourcesFor`. */
function baseOf(url: string): string {
  const g = gateways.find((x) => url.startsWith(x.url.replace(/\/+$/, "")));
  return g ? g.url.replace(/\/+$/, "") : new URL(url).origin;
}

export interface ShaRef {
  cid?: string;
  sha256: string;
  arweave?: string;
}

/** Fetch a file by its SHA-256 from IPFS gateways (own, pinning, public) and then Arweave. */
export async function fetchBySha(ref: ShaRef, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const sources = sourcesFor({ cid: ref.cid, arweave: ref.arweave }, gateways, scoreboard);
  return fetchVerified({
    sources,
    sha256: ref.sha256,
    scoreboard,
    fetch: (u, i) => doFetch(u, i),
    maxBytes: opts.maxBytes,
    timeoutMs: opts.timeoutMs,
    onReport: (r) => record(baseOf(r.url), r),
  });
}

/** Trustless block source over the IPFS gateways, best first. */
export function blockSource(): BlockSource {
  return {
    gateways: () =>
      scoreboard.order(
        gateways
          .filter((g) => g.network === "ipfs")
          .sort((a, b) => rank(a) - rank(b))
          .map((g) => g.url.replace(/\/+$/, "")),
        (x) => x,
      ),
    fetch: (u, i) => doFetch(u, i),
    onReport: (r) => {
      scoreboard.record(r.base, r);
      record(r.base, r);
    },
  };
}

const rank = (g: GatewayEntry) => ({ own: 0, pinning: 1, public: 2 })[g.operator];

/** Fetch a file by CID, verifying every block against its hash. */
export function fetchByCid(cid: string, maxBytes?: number): Promise<Uint8Array> {
  return fetchFileByCid(cid, blockSource(), maxBytes);
}

/** Fetch `cid/path`, resolving the path through verified directory blocks. */
export function fetchByPath(path: string, maxBytes?: number): Promise<Uint8Array> {
  return fetchIpfsPath(path, blockSource(), maxBytes);
}

/** Plain gateway links for showing a hash or CID to the reader (not used for display; nothing here is verified). */
export function gatewayLinks(cid: string): string[] {
  return gateways.filter((g) => g.network === "ipfs").map((g) => `${g.url.replace(/\/+$/, "")}/ipfs/${cid}`);
}

export function arweaveLinks(tx: string): string[] {
  return gateways.filter((g) => g.network === "arweave").map((g) => `${g.url.replace(/\/+$/, "")}/${tx}`);
}
