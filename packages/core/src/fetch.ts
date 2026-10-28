import { sha256Hex, hexEquals } from "@azaadawaaz/schema";
import type { GatewayEntry } from "./lists.js";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface SourceReport {
  url: string;
  ok: boolean;
  /** "mismatch" means the source served bytes that don't match the expected hash; it should be flagged. */
  reason?: "mismatch" | "http" | "timeout" | "network" | "too-large";
  ms: number;
}

/** Remembers how each gateway performed so the fastest healthy ones are tried first. */
export class GatewayScoreboard {
  private readonly stats = new Map<string, { ok: number; fail: number; mismatch: number; avgMs: number }>();

  record(base: string, r: SourceReport): void {
    const s = this.stats.get(base) ?? { ok: 0, fail: 0, mismatch: 0, avgMs: 0 };
    if (r.ok) {
      s.avgMs = s.ok === 0 ? r.ms : s.avgMs * 0.7 + r.ms * 0.3;
      s.ok++;
    } else if (r.reason === "mismatch") s.mismatch++;
    else s.fail++;
    this.stats.set(base, s);
  }

  /** Lower is better. Gateways that served wrong bytes go last. */
  score(base: string): number {
    const s = this.stats.get(base);
    if (!s) return 1000; // unknown: try after proven-fast ones, before failing ones
    if (s.mismatch > 0) return 1e9;
    const failRate = s.fail / (s.ok + s.fail);
    return (s.ok ? s.avgMs : 3000) * (1 + 4 * failRate);
  }

  order<T>(items: T[], baseOf: (t: T) => string): T[] {
    return items
      .map((t, i) => ({ t, i, s: this.score(baseOf(t)) }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.t);
  }

  isFlagged(base: string): boolean {
    return (this.stats.get(base)?.mismatch ?? 0) > 0;
  }
}

const OPERATOR_RANK = { own: 0, pinning: 1, public: 2 } as const;

/** Candidate URLs for a file, own gateways first, then pinning services, then public ones (spec §8). */
export function sourcesFor(
  ref: { cid?: string; path?: string; arweave?: string },
  gateways: GatewayEntry[],
  scoreboard?: GatewayScoreboard,
): { base: string; url: string }[] {
  const ranked = [...gateways].sort((a, b) => OPERATOR_RANK[a.operator] - OPERATOR_RANK[b.operator]);
  const strip = (u: string) => u.replace(/\/+$/, "");
  const ipfs = ref.cid
    ? ranked
        .filter((g) => g.network === "ipfs")
        .map((g) => ({ base: strip(g.url), url: `${strip(g.url)}/ipfs/${ref.cid}${ref.path ? "/" + ref.path : ""}` }))
    : [];
  const ar = ref.arweave
    ? ranked
        .filter((g) => g.network === "arweave")
        .map((g) => ({ base: strip(g.url), url: `${strip(g.url)}/${ref.arweave}` }))
    : [];
  // Within each network keep operator order but let the scoreboard promote fast gateways of the same tier.
  const order = (xs: { base: string; url: string }[]) => (scoreboard ? scoreboard.order(xs, (x) => x.base) : xs);
  return [...order(ipfs), ...order(ar)];
}

export interface FetchVerifiedOptions {
  sources: { base: string; url: string }[];
  sha256: string;
  fetch?: FetchLike;
  /** How many sources to race at once (default 3). */
  raceWidth?: number;
  timeoutMs?: number;
  maxBytes?: number;
  scoreboard?: GatewayScoreboard;
  onReport?: (r: SourceReport) => void;
}

export class VerifiedFetchError extends Error {
  constructor(
    message: string,
    readonly reports: SourceReport[],
  ) {
    super(message);
    this.name = "VerifiedFetchError";
  }
}

/**
 * Fetch a file from the fastest source whose bytes match `sha256`. Sources are raced `raceWidth` at a time; the first
 * verified response wins and the others are aborted. Bytes that don't match are never returned (spec §1.1 principle 4).
 */
export async function fetchVerified(opts: FetchVerifiedOptions): Promise<Uint8Array> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const width = Math.max(1, opts.raceWidth ?? 3);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const reports: SourceReport[] = [];
  const queue = [...opts.sources];

  const attempt = async (src: { base: string; url: string }, outer: AbortSignal): Promise<Uint8Array> => {
    const ctl = new AbortController();
    const onOuter = () => ctl.abort();
    outer.addEventListener("abort", onOuter);
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    const report = (r: Omit<SourceReport, "url" | "ms">) => {
      const full = { url: src.url, ms: Date.now() - t0, ...r };
      if (!outer.aborted || r.ok) {
        reports.push(full);
        opts.scoreboard?.record(src.base, full);
        opts.onReport?.(full);
      }
    };
    try {
      const res = await doFetch(src.url, { signal: ctl.signal });
      if (!res.ok) {
        report({ ok: false, reason: "http" });
        throw new Error(`HTTP ${res.status}`);
      }
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > maxBytes) {
        report({ ok: false, reason: "too-large" });
        throw new Error("too large");
      }
      // Stream with a cap: a hostile gateway must not be able to exhaust memory with an endless body.
      const bytes = await readCapped(res, maxBytes);
      if (!bytes) {
        report({ ok: false, reason: "too-large" });
        throw new Error("too large");
      }
      if (!hexEquals(sha256Hex(bytes), opts.sha256)) {
        report({ ok: false, reason: "mismatch" });
        throw new Error("hash mismatch");
      }
      report({ ok: true });
      return bytes;
    } catch (e) {
      if (!reports.some((r) => r.url === src.url) && !outer.aborted) {
        report({ ok: false, reason: ctl.signal.aborted ? "timeout" : "network" });
      }
      throw e;
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", onOuter);
    }
  };

  while (queue.length) {
    const batch = queue.splice(0, width);
    const ctl = new AbortController();
    try {
      const bytes = await Promise.any(batch.map((s) => attempt(s, ctl.signal)));
      ctl.abort();
      return bytes;
    } catch {
      // every source in the batch failed; try the next batch
    }
  }
  throw new VerifiedFetchError(`no source served a file matching sha256 ${opts.sha256}`, reports);
}

/** Read a body, returning null as soon as it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    return b.length > max ? null : b;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
