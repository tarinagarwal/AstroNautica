import { create, type KuboRPCClient } from "kubo-rpc-client";
import type { PinningService } from "./config.js";

/** Settings every node must use so the same bytes get the same CID on every node (spec §6 step 3: CIDv1). */
const ADD_OPTS = { cidVersion: 1 as const, rawLeaves: true, chunker: "size-262144", pin: true };

export interface DirEntry {
  path: string;
  content: Uint8Array;
}

/** Adds to and reads from all of our own Kubo nodes. */
export class IpfsCluster {
  private readonly clients: { url: string; client: KuboRPCClient }[];

  constructor(apiUrls: string[]) {
    if (apiUrls.length === 0) throw new Error("no IPFS API URLs configured");
    this.clients = apiUrls.map((url) => ({ url, client: create({ url }) }));
  }

  get size(): number {
    return this.clients.length;
  }

  /**
   * Add a file to every node. All nodes must agree on the CID. Succeeds if at least `minNodes` nodes stored it
   * (spec: at least two of our own nodes); failures are reported.
   */
  async addFile(
    content: Uint8Array,
    minNodes = Math.min(2, this.clients.length),
  ): Promise<{ cid: string; nodes: string[] }> {
    return this.onAll(minNodes, async (c) => (await c.add(content, ADD_OPTS)).cid.toString());
  }

  /** Add a directory (e.g. an HLS folder) to every node and return the directory CID. */
  async addDirectory(
    entries: DirEntry[],
    minNodes = Math.min(2, this.clients.length),
  ): Promise<{ cid: string; nodes: string[] }> {
    return this.onAll(minNodes, async (c) => {
      let root: string | undefined;
      for await (const r of c.addAll(
        entries.map((e) => ({ path: `d/${e.path}`, content: e.content })),
        { ...ADD_OPTS, wrapWithDirectory: false },
      )) {
        if (r.path === "d") root = r.cid.toString();
      }
      if (!root) throw new Error("directory CID missing from add response");
      return root;
    });
  }

  /** Read a file by CID (or CID path) from the first node that has it. */
  async cat(path: string, maxBytes = 3 * 1024 * 1024 * 1024): Promise<Uint8Array> {
    let lastErr: unknown;
    for (const { client } of this.clients) {
      try {
        const parts: Uint8Array[] = [];
        let n = 0;
        for await (const chunk of client.cat(path, { timeout: 120_000 })) {
          n += chunk.length;
          if (n > maxBytes) throw new Error("file too large");
          parts.push(chunk);
        }
        const out = new Uint8Array(n);
        let off = 0;
        for (const p of parts) {
          out.set(p, off);
          off += p.length;
        }
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`could not read ${path} from any IPFS node: ${String(lastErr)}`);
  }

  private async onAll(
    minNodes: number,
    fn: (c: KuboRPCClient) => Promise<string>,
  ): Promise<{ cid: string; nodes: string[] }> {
    const results = await Promise.allSettled(
      this.clients.map(async ({ url, client }) => ({ url, cid: await fn(client) })),
    );
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const cids = new Set(ok.map((r) => r.cid));
    if (cids.size > 1) throw new Error(`IPFS nodes disagree on the CID: ${[...cids].join(", ")}`);
    if (ok.length < minNodes) {
      const errs = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
      throw new Error(
        `only ${ok.length}/${this.clients.length} IPFS nodes stored the file (need ${minNodes}): ${errs.join("; ")}`,
      );
    }
    return { cid: ok[0]!.cid, nodes: ok.map((r) => r.url) };
  }
}

export interface PinStatus {
  service: string;
  requestid?: string;
  status: "queued" | "pinning" | "pinned" | "failed" | "error";
  error?: string;
}

/**
 * Client for the standard IPFS Pinning Service API (https://ipfs.github.io/pinning-services-api-spec/), implemented by
 * Filebase, Pinata, 4EVERLAND and others — so the provider is swappable by configuration (spec §6 step 3).
 */
export class PinningClient {
  constructor(
    private readonly svc: PinningService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.svc.endpoint.replace(/\/+$/, "")}${path}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.svc.token}`, "Content-Type": "application/json" };
  }

  async pin(cid: string, name: string, origins: string[]): Promise<PinStatus> {
    try {
      const res = await this.fetchImpl(this.url("/pins"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ cid, name, origins }),
      });
      if (!res.ok) return { service: this.svc.name, status: "error", error: `HTTP ${res.status}: ${await res.text()}` };
      const j = (await res.json()) as { requestid: string; status: PinStatus["status"] };
      return { service: this.svc.name, requestid: j.requestid, status: j.status };
    } catch (e) {
      return { service: this.svc.name, status: "error", error: String(e) };
    }
  }

  async status(requestid: string): Promise<PinStatus> {
    try {
      const res = await this.fetchImpl(this.url(`/pins/${encodeURIComponent(requestid)}`), { headers: this.headers() });
      if (!res.ok) return { service: this.svc.name, requestid, status: "error", error: `HTTP ${res.status}` };
      const j = (await res.json()) as { status: PinStatus["status"] };
      return { service: this.svc.name, requestid, status: j.status };
    } catch (e) {
      return { service: this.svc.name, requestid, status: "error", error: String(e) };
    }
  }
}

/** Multiaddrs of our nodes, given to pinning services as `origins` so they fetch from us directly. */
export async function nodeOrigins(apiUrls: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const url of apiUrls) {
    try {
      const id = await create({ url }).id();
      out.push(
        ...id.addresses.map((a) => a.toString()).filter((a) => !a.includes("/127.0.0.1/") && !a.includes("/::1/")),
      );
    } catch {
      // a node being down only means fewer origins
    }
  }
  return out;
}
