/**
 * AzaadAwaazRegistry receipts over plain JSON-RPC (spec §8.1 Verify, §9): `receipt(bytes16,uint32,address)` via
 * eth_call for each publisher EVM address on the owner-signed service-keys list, and the `Published` event via
 * eth_getLogs for the transaction and block time. A receipt counts only when its writer was the publisher's EVM key
 * at the receipt's block time (core `wasPublisherEvmAt`). Every call goes through the app's network layer (Tor/DoH).
 */
import { publisherEvmAddresses, wasPublisherEvmAt, type EffectiveLists } from "@azaadawaaz/core";
import { chainById } from "@azaadawaaz/contracts";
import { storyIdToBytes16 } from "@azaadawaaz/schema";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ChainConfig } from "../config";
import type { Http } from "../platform/types";

export const RECEIPT_SIGNATURE = "receipt(bytes16,uint32,address)";
export const PUBLISHED_SIGNATURE = "Published(bytes16,uint32,address,bytes32,string,uint64)";
export const RECEIPT_SELECTOR = "0x" + bytesToHex(keccak_256(utf8ToBytes(RECEIPT_SIGNATURE))).slice(0, 8);
export const PUBLISHED_TOPIC = "0x" + bytesToHex(keccak_256(utf8ToBytes(PUBLISHED_SIGNATURE)));

const pad = (hex: string, right = false) => (right ? hex.padEnd(64, "0") : hex.padStart(64, "0"));
const addr = (a: string) => a.toLowerCase().replace(/^0x/, "");

export function encodeReceiptCall(storyId: string, version: number, by: string): string {
  return RECEIPT_SELECTOR + pad(storyIdToBytes16(storyId).slice(2), true) + pad(version.toString(16)) + pad(addr(by));
}

export function storyTopic(storyId: string): string {
  return "0x" + pad(storyIdToBytes16(storyId).slice(2), true);
}
export const versionTopic = (v: number) => "0x" + pad(v.toString(16));
export const addressTopic = (a: string) => "0x" + pad(addr(a));

let nextId = 1;

export async function rpc<T>(http: Http, urls: string[], method: string, params: unknown[]): Promise<T> {
  let lastErr: unknown = new Error("no RPC URL configured");
  for (const url of urls) {
    try {
      const res = await http.request({
        url,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        timeoutMs: 15_000,
        maxBytes: 8 * 1024 * 1024,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(new TextDecoder().decode(res.body)) as { result?: T; error?: { message: string } };
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
  manifestSha256?: string;
  timestamp?: number;
  /** EVM address that wrote the receipt. */
  by?: string;
  txHash?: string;
  blockNumber?: number;
  manifestCid?: string;
  error?: "not-found" | "mismatch" | "unreachable" | "not-publisher";
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

/** Decode the `receipt(...)` return value. */
export function decodeReceipt(result: string): { sha: string; timestamp: number } | undefined {
  const d = (result ?? "").replace(/^0x/, "");
  const sha = d.slice(0, 64);
  if (!sha || /^0+$/.test(sha)) return undefined;
  return { sha, timestamp: parseInt(d.slice(64, 128) || "0", 16) };
}

export const rpcUrls = (c: ChainConfig) => [c.rpc, ...(c.rpcs ?? [])].filter(Boolean);

async function blockAt(http: Http, c: ChainConfig, ts: number): Promise<number> {
  const latest = parseInt(await rpc<string>(http, rpcUrls(c), "eth_blockNumber", []), 16);
  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc<{ timestamp: string }>(http, rpcUrls(c), "eth_getBlockByNumber", [
      "0x" + mid.toString(16),
      false,
    ]);
    if (parseInt(b.timestamp, 16) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function findLog(http: Http, c: ChainConfig, storyId: string, version: number, by: string, ts: number) {
  const filter = (from: string, to: string) => ({
    address: c.registry,
    fromBlock: from,
    toBlock: to,
    topics: [PUBLISHED_TOPIC, storyTopic(storyId), versionTopic(version), addressTopic(by)],
  });
  let logs: Log[];
  try {
    logs = await rpc<Log[]>(http, rpcUrls(c), "eth_getLogs", [filter("0x0", "latest")]);
  } catch {
    // Public RPCs often refuse a log query from block 0: find the block by its timestamp instead.
    const b = await blockAt(http, c, ts);
    logs = await rpc<Log[]>(http, rpcUrls(c), "eth_getLogs", [
      filter("0x" + Math.max(0, b - 5).toString(16), "0x" + (b + 5).toString(16)),
    ]);
  }
  const l = logs[0];
  return l ? { log: l, decoded: decodePublishedData(l.data) } : undefined;
}

type ReceiptLists = Pick<EffectiveLists, "serviceKeys">;

/**
 * Check one chain's receipt for (storyId, version) against the expected manifest hash: look it up under every
 * publisher EVM address and accept it only if its writer was the publisher at the block time.
 */
export async function checkChainReceipt(
  http: Http,
  c: ChainConfig,
  storyId: string,
  version: number,
  expectedSha256: string,
  lists: ReceiptLists,
): Promise<ChainReceipt> {
  const publishers = publisherEvmAddresses(lists);
  if (!publishers.length) return { chain: c, ok: false, error: "not-found" };
  let best: ChainReceipt | undefined;
  let reached = false;
  for (const by of publishers) {
    let result: string;
    try {
      result = await rpc<string>(http, rpcUrls(c), "eth_call", [
        { to: c.registry, data: encodeReceiptCall(storyId, version, by) },
        "latest",
      ]);
      reached = true;
    } catch {
      continue;
    }
    const r = decodeReceipt(result);
    if (!r) continue;
    const out: ChainReceipt = { chain: c, ok: false, manifestSha256: r.sha, timestamp: r.timestamp, by };
    if (!wasPublisherEvmAt(lists, by, r.timestamp)) out.error = "not-publisher";
    else if (r.sha !== expectedSha256.toLowerCase()) out.error = "mismatch";
    else out.ok = true;
    if (!best || (out.ok && !best.ok)) best = out;
    if (out.ok) break;
  }
  if (!best) return { chain: c, ok: false, error: reached ? "not-found" : "unreachable" };
  try {
    const found = await findLog(http, c, storyId, version, best.by!, best.timestamp ?? 0);
    if (found) {
      best.txHash = found.log.transactionHash;
      best.blockNumber = parseInt(found.log.blockNumber, 16);
      best.manifestCid = found.decoded.cid;
    }
  } catch {
    // The receipt itself is what matters; the transaction lookup is informational.
  }
  return best;
}

/** The manifest CID and hash of a version from a valid chain receipt (used to find earlier versions). */
export async function findPublishedCid(
  http: Http,
  chains: ChainConfig[],
  storyId: string,
  version: number,
  lists: ReceiptLists,
): Promise<{ cid: string; sha: string } | undefined> {
  for (const c of chains) {
    for (const by of publisherEvmAddresses(lists)) {
      try {
        const result = await rpc<string>(http, rpcUrls(c), "eth_call", [
          { to: c.registry, data: encodeReceiptCall(storyId, version, by) },
          "latest",
        ]);
        const r = decodeReceipt(result);
        if (!r || !wasPublisherEvmAt(lists, by, r.timestamp)) continue;
        const found = await findLog(http, c, storyId, version, by, r.timestamp);
        if (found && found.decoded.sha === r.sha) return { cid: found.decoded.cid, sha: r.sha };
      } catch {
        // try the next one
      }
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
