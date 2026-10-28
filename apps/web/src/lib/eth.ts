/**
 * Read AzaadAwaazRegistry receipts with plain JSON-RPC (no web3 library): `receipt(bytes16,uint32,address)` via
 * eth_call and the `Published` event via eth_getLogs for the transaction (spec §8.1 Verify, §9).
 *
 * Receipts are stored per writer. A receipt counts only if its writer was the publisher's EVM key on the owner-signed
 * service-keys list at the receipt's block time, which the writer cannot choose (security review #10).
 */
import { chainById, registryAbi } from "@azaadawaaz/contracts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { storyIdToBytes16 } from "@azaadawaaz/schema";
import type { ChainConfig } from "../config.js";

type AbiParam = { readonly type: string };
type AbiItem = { readonly type: string; readonly name?: string; readonly inputs?: readonly AbiParam[] };

function signature(kind: "function" | "event", name: string): string {
  const item = (registryAbi as readonly AbiItem[]).find((i) => i.type === kind && i.name === name);
  if (!item) throw new Error(`${name} missing from registry ABI`);
  return `${name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`;
}

export const RECEIPT_SIGNATURE = signature("function", "receipt");
export const PUBLISHED_SIGNATURE = signature("event", "Published");
export const RECEIPT_SELECTOR = "0x" + bytesToHex(keccak_256(utf8ToBytes(RECEIPT_SIGNATURE))).slice(0, 8);
export const PUBLISHED_TOPIC = "0x" + bytesToHex(keccak_256(utf8ToBytes(PUBLISHED_SIGNATURE)));

const pad = (hex: string, right = false) => (right ? hex.padEnd(64, "0") : hex.padStart(64, "0"));

export function encodeReceiptCall(storyId: string, version: number, by: string): string {
  const id = storyIdToBytes16(storyId).slice(2);
  return RECEIPT_SELECTOR + pad(id, true) + pad(version.toString(16)) + pad(by.replace(/^0x/, "").toLowerCase());
}

/** An EVM address that served as publisher, with the window it was valid in (from the signed service-keys list). */
export interface PublisherWindow {
  address: string;
  from: number;
  until?: number;
}

/** The indexed bytes16 storyId topic (left-aligned in 32 bytes). */
export function storyTopic(storyId: string): string {
  return "0x" + pad(storyIdToBytes16(storyId).slice(2), true);
}

export interface RpcFetch {
  (url: string, init: RequestInit): Promise<Response>;
}

let nextId = 1;

export async function rpc<T>(urls: string[], method: string, params: unknown[], f: RpcFetch = fetch): Promise<T> {
  let lastErr: unknown = new Error("no RPC URL configured");
  for (const url of urls) {
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export interface ChainReceipt {
  chain: ChainConfig;
  ok: boolean;
  /** Manifest hash recorded on chain (hex, no 0x), if any. */
  manifestSha256?: string;
  timestamp?: number;
  txHash?: string;
  blockNumber?: number;
  manifestCid?: string;
  error?: "not-found" | "mismatch" | "unreachable";
}

interface Log {
  data: string;
  topics: string[];
  transactionHash: string;
  blockNumber: string;
}

/** Decode the non-indexed part of `Published`: (bytes32 sha, string cid, uint64 timestamp). */
export function decodePublishedData(data: string): { sha: string; cid: string; timestamp: number } {
  const d = data.replace(/^0x/, "");
  const word = (i: number) => d.slice(i * 64, i * 64 + 64);
  const sha = word(0);
  const offset = parseInt(word(1), 16) / 32;
  const timestamp = parseInt(word(2), 16);
  const len = parseInt(word(offset), 16);
  const hex = d.slice((offset + 1) * 64, (offset + 1) * 64 + len * 2);
  const bytes = new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  return { sha, cid: new TextDecoder().decode(bytes), timestamp };
}

/** Indexed topics of `Published`: storyId (bytes16, left-aligned), version and publisher (right-aligned). */
export function versionTopic(version: number): string {
  return "0x" + pad(version.toString(16));
}
export function addressTopic(address: string): string {
  return "0x" + pad(address.replace(/^0x/, "").toLowerCase());
}

const rpcUrls = (c: ChainConfig) => [c.rpc, ...(c.rpcs ?? [])].filter(Boolean);

/** Find the block whose timestamp is `ts` by binary search (RPCs often refuse eth_getLogs from block 0). */
async function blockAt(c: ChainConfig, ts: number, f: RpcFetch): Promise<number> {
  const latest = parseInt(await rpc<string>(rpcUrls(c), "eth_blockNumber", [], f), 16);
  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc<{ timestamp: string }>(rpcUrls(c), "eth_getBlockByNumber", ["0x" + mid.toString(16), false], f);
    if (parseInt(b.timestamp, 16) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function findLog(c: ChainConfig, storyId: string, version: number, by: string, ts: number, f: RpcFetch) {
  const filter = (from: string, to: string) => ({
    address: c.registry,
    fromBlock: from,
    toBlock: to,
    topics: [PUBLISHED_TOPIC, storyTopic(storyId), versionTopic(version), addressTopic(by)],
  });
  let logs: Log[];
  try {
    logs = await rpc<Log[]>(rpcUrls(c), "eth_getLogs", [filter("0x0", "latest")], f);
  } catch {
    const b = await blockAt(c, ts, f);
    logs = await rpc<Log[]>(
      rpcUrls(c),
      "eth_getLogs",
      [filter("0x" + Math.max(0, b - 5).toString(16), "0x" + (b + 5).toString(16))],
      f,
    );
  }
  const l = logs[0];
  return l ? { log: l, decoded: decodePublishedData(l.data) } : undefined;
}

/** Read the receipt written by `by`; null when there is none. */
async function readReceipt(c: ChainConfig, storyId: string, version: number, by: string, f: RpcFetch) {
  const result = await rpc<string>(
    rpcUrls(c),
    "eth_call",
    [{ to: c.registry, data: encodeReceiptCall(storyId, version, by) }, "latest"],
    f,
  );
  const d = (result ?? "").replace(/^0x/, "");
  const sha = d.slice(0, 64);
  if (!sha || /^0+$/.test(sha)) return null;
  return { sha, timestamp: parseInt(d.slice(64, 128) || "0", 16) };
}

const validAt = (p: PublisherWindow, ts: number) => p.from <= ts && (p.until === undefined || ts < p.until);

/**
 * Check one chain's receipt for (storyId, version) against the expected manifest hash. Receipts are looked up for
 * every publisher EVM key on the signed list; one counts only if written while that key was valid.
 */
export async function checkChainReceipt(
  c: ChainConfig,
  storyId: string,
  version: number,
  expectedSha256: string,
  publishers: PublisherWindow[],
  f: RpcFetch = fetch,
): Promise<ChainReceipt> {
  let best: ChainReceipt | undefined;
  let reached = false;
  for (const p of publishers) {
    let r: { sha: string; timestamp: number } | null;
    try {
      r = await readReceipt(c, storyId, version, p.address, f);
      reached = true;
    } catch {
      continue;
    }
    if (!r || !validAt(p, r.timestamp)) continue;
    const out: ChainReceipt = {
      chain: c,
      ok: r.sha === expectedSha256.toLowerCase(),
      manifestSha256: r.sha,
      timestamp: r.timestamp,
    };
    if (!out.ok) out.error = "mismatch";
    if (out.ok || !best) best = out;
    if (out.ok) {
      try {
        const found = await findLog(c, storyId, version, p.address, r.timestamp, f);
        if (found) {
          out.txHash = found.log.transactionHash;
          out.blockNumber = parseInt(found.log.blockNumber, 16);
          out.manifestCid = found.decoded.cid;
        }
      } catch {
        // The receipt itself is what matters; the transaction lookup is informational.
      }
      break;
    }
  }
  if (best) return best;
  return { chain: c, ok: false, error: reached || publishers.length === 0 ? "not-found" : "unreachable" };
}

/** The manifest CID and hash of a version from a valid chain receipt (used to find earlier versions). */
export async function findPublishedCid(
  chains: ChainConfig[],
  storyId: string,
  version: number,
  publishers: PublisherWindow[],
  f: RpcFetch = fetch,
): Promise<{ cid: string; sha: string } | undefined> {
  for (const c of chains) {
    for (const p of publishers) {
      try {
        const r = await readReceipt(c, storyId, version, p.address, f);
        if (!r || !validAt(p, r.timestamp)) continue;
        const found = await findLog(c, storyId, version, p.address, r.timestamp, f);
        if (found && found.decoded.sha === r.sha) return { cid: found.decoded.cid, sha: r.sha };
      } catch {
        // try the next one
      }
    }
  }
  return undefined;
}

/** Publisher EVM keys and their validity windows from the effective lists. */
export function publisherWindows(
  serviceKeys: { role: string; evm?: string; from: number; until?: number }[],
): PublisherWindow[] {
  return serviceKeys
    .filter((k) => k.role === "publisher" && k.evm)
    .map((k) => ({ address: k.evm!, from: k.from, ...(k.until !== undefined ? { until: k.until } : {}) }));
}

export function chainName(c: ChainConfig): string {
  return c.name ?? chainById(c.chainId)?.name ?? c.key;
}

export function explorerTx(c: ChainConfig, tx: string): string | undefined {
  const base = c.explorer ?? chainById(c.chainId)?.explorer?.url;
  return base ? `${base.replace(/\/+$/, "")}/tx/${tx}` : undefined;
}
