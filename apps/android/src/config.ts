import type { Event } from "nostr-tools/pure";
import bundled from "./defaults.json";

export interface ChainConfig {
  key: string;
  chainId: number;
  rpc: string;
  rpcs?: string[];
  registry: string;
  name?: string;
  explorer?: string;
}

/** Build-time configuration: the pinned owner key and bundled owner-signed lists (spec §3). Public data only. */
export interface AppConfig {
  ownerPubkey: string;
  listEvents: Event[];
  apiUrl: string;
  bootstrapRelays: string[];
  chains: ChainConfig[];
  /** IPFS CIDs of JSON arrays of signed list events (copies of the official lists); each event is verified. */
  listSnapshots: string[];
  powDifficulty: number;
  /** Telegram channel for announcing new doors (owner decision; empty until set). */
  telegram: string;
}

export function normalizeConfig(c: Partial<AppConfig>): AppConfig {
  return {
    ownerPubkey: typeof c.ownerPubkey === "string" && /^[0-9a-f]{64}$/.test(c.ownerPubkey) ? c.ownerPubkey : "",
    listEvents: Array.isArray(c.listEvents) ? c.listEvents : [],
    apiUrl: typeof c.apiUrl === "string" ? c.apiUrl.replace(/\/+$/, "") : "",
    bootstrapRelays: Array.isArray(c.bootstrapRelays) ? c.bootstrapRelays.filter((r) => typeof r === "string") : [],
    chains: Array.isArray(c.chains) ? c.chains : [],
    listSnapshots: Array.isArray(c.listSnapshots) ? c.listSnapshots : [],
    powDifficulty: typeof c.powDifficulty === "number" ? c.powDifficulty : 16,
    telegram: typeof c.telegram === "string" ? c.telegram : "",
  };
}

export const bundledConfig: AppConfig = normalizeConfig(bundled as Partial<AppConfig>);
