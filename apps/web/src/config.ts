import type { Event } from "@core/index.js";
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

/** Build-time configuration: the pinned owner key and bundled owner-signed lists (spec §3, architecture "Web app"). */
export interface AppConfig {
  ownerPubkey: string;
  listEvents: Event[];
  apiUrl: string;
  bootstrapRelays: string[];
  chains: ChainConfig[];
  /** IPFS CIDs of JSON arrays of signed list events (copies of the official lists); each event is verified. */
  listSnapshots: string[];
  powDifficulty: number;
}

let current: AppConfig = normalize(bundled as Partial<AppConfig>);

export function normalize(c: Partial<AppConfig>): AppConfig {
  return {
    ownerPubkey: typeof c.ownerPubkey === "string" ? c.ownerPubkey : "",
    listEvents: Array.isArray(c.listEvents) ? c.listEvents : [],
    apiUrl: typeof c.apiUrl === "string" ? c.apiUrl.replace(/\/+$/, "") : "",
    bootstrapRelays: Array.isArray(c.bootstrapRelays) ? c.bootstrapRelays : [],
    chains: Array.isArray(c.chains) ? c.chains : [],
    listSnapshots: Array.isArray(c.listSnapshots) ? c.listSnapshots : [],
    powDifficulty: typeof c.powDifficulty === "number" ? c.powDifficulty : 16,
  };
}

export function getConfig(): AppConfig {
  return current;
}

/** Replace the configuration (tests). */
export function setConfig(c: Partial<AppConfig>): void {
  current = normalize(c);
}
