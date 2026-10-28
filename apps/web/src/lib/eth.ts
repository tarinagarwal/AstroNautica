/**
 * Read AzaadAwaazRegistry receipts with plain JSON-RPC (no web3 library): `receipt(bytes16,uint32)` via eth_call and
 * the `Published` event via eth_getLogs for the transaction and block time (spec §8.1 Verify, §9).
 */
import { chainById, registryAbi } from "@azaadawaaz/contracts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { storyIdToBytes16 } from "@azaadawaaz/schema";
import type { ChainConfig } from "../config.js";

type AbiParam = { type: string };
type AbiItem = { type: string; name?: string; inputs?: AbiParam[] };

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

export function encodeReceiptCall(storyId: string, version: number): string {
  const id = storyIdToBytes16(storyId).slice(2);
  return RECEIPT_SELECTOR + pad(id, true) + pad(version.toString(16));
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

/** Decode the non-indexed part of `Published`: (uint32 version, bytes32 sha, string cid, uint64 timestamp). */
export function decodePublishedData(data: string): { version: number; sha: string; cid: string; timestamp: number } {
  const d = data.replace(/^0x/, "");
  const word = (i: number) => d.slice(i * 64, i * 64 + 64);
  const version = parseInt(word(0), 16);
  const sha = word(1);
  const offset = parseInt(word(2), 16) / 32;
  const timestamp = parseInt(word(3), 16);
  const len = parseInt(word(offset), 16);
  const hex = d.slice((offset + 1) * 64, (offset + 1) * 64 + len * 2);
  const bytes = new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  return { version, sha, cid: new TextDecoder().decode(bytes), timestamp };
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

async function findLog(c: ChainConfig, storyId: string, version: number, ts: number, f: RpcFetch) {
  const filter = (from: string, to: string) => ({
    address: c.registry,
    fromBlock: from,
    toBlock: to,
    topics: [PUBLISHED_TOPIC, storyTopic(storyId)],
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
  for (const l of logs) {
    const d = decodePublishedData(l.data);
    if (d.version === version) return { log: l, decoded: d };
  }
  return undefined;
}

/** Check one chain's receipt for (storyId, version) against the expected manifest hash. */
export async function checkChainReceipt(
  c: ChainConfig,
  storyId: string,
  version: number,
  expectedSha256: string,
  f: RpcFetch = fetch,
): Promise<ChainReceipt> {
  let result: string;
  try {
    result = await rpc<string>(rpcUrls(c), "eth_call", [{ to: c.registry, data: encodeReceiptCall(storyId, version) }, "latest"], f);
  } catch {
    return { chain: c, ok: false, error: "unreachable" };
  }
  const d = (result ?? "").replace(/^0x/, "");
  const sha = d.slice(0, 64);
  const timestamp = parseInt(d.slice(64, 128) || "0", 16);
  if (!sha || /^0+$/.test(sha)) return { chain: c, ok: false, error: "not-found" };
  const out: ChainReceipt = { chain: c, ok: sha === expectedSha256.toLowerCase(), manifestSha256: sha, timestamp };
  if (!out.ok) out.error = "mismatch";
  try {
    const found = await findLog(c, storyId, version, timestamp, f);
    if (found) {
      out.txHash = found.log.transactionHash;
      out.blockNumber = parseInt(found.log.blockNumber, 16);
      out.manifestCid = found.decoded.cid;
      const block = await rpc<{ timestamp: string }>(rpcUrls(c), "eth_getBlockByNumber", [found.log.blockNumber, false], f);
      out.timestamp = parseInt(block.timestamp, 16);
    }
  } catch {
    // The receipt itself is what matters; the transaction lookup is informational.
  }
  return out;
}

/** The manifest CID and hash of a version from its chain receipt (used to find earlier versions). */
export async function findPublishedCid(
  chains: ChainConfig[],
  storyId: string,
  version: number,
  f: RpcFetch = fetch,
): Promise<{ cid: string; sha: string } | undefined> {
  for (const c of chains) {
    try {
      const result = await rpc<string>(
        rpcUrls(c),
        "eth_call",
        [{ to: c.registry, data: encodeReceiptCall(storyId, version) }, "latest"],
        f,
      );
      const d = (result ?? "").replace(/^0x/, "");
      if (!d.slice(0, 64) || /^0+$/.test(d.slice(0, 64))) continue;
      const found = await findLog(c, storyId, version, parseInt(d.slice(64, 128) || "0", 16), f);
      if (found) return { cid: found.decoded.cid, sha: found.decoded.sha };
    } catch {
      // try the next chain
    }
  }
  return undefined;
}

export function chainName(c: ChainConfig): string {
  return c.name ?? chainById(c.chainId)?.name ?? c.key;
}

export function explorerTx(c: ChainConfig, tx: string): string | undefined {
  const base = c.explorer ?? chainById(c.chainId)?.explorer?.url;
  return base ? `${base.replace(/\/+$/, "")}/tx/${tx}` : undefined;
}
