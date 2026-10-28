/**
 * Transport selection (spec §8.2, §10): direct connections use DNS-over-HTTPS; "Blocked? Use Tor" routes everything
 * (requests, relay WebSockets, video) through the built-in Tor with Snowflake or obfs4 bridges. When every relay and
 * every gateway is unreachable directly, Tor is switched on automatically (unless the user turned that off).
 */

export type Bridges = "none" | "snowflake" | "obfs4";

export interface TorStatus {
  state: "off" | "starting" | "on" | "stopping" | "error";
  socksPort: number;
  bootstrap: number;
  bridges?: Bridges;
  error?: string;
}

export interface NetSettings {
  /** The user's switch. */
  torEnabled: boolean;
  bridges: Bridges;
  /** Switch Tor on by itself when direct connections fail. */
  autoTor: boolean;
  /** Tor was switched on automatically (shown in the UI; turned off again on request). */
  autoEnabled: boolean;
}

export const DEFAULT_NET_SETTINGS: NetSettings = {
  torEnabled: false,
  bridges: "snowflake",
  autoTor: true,
  autoEnabled: false,
};

export interface Reachability {
  relays: { url: string; ok: boolean }[];
  gateways: { url: string; ok: boolean }[];
  at: number;
}

/** True when nothing we depend on answered directly: every relay and every gateway failed. */
export function allUnreachable(r: Reachability): boolean {
  const total = r.relays.length + r.gateways.length;
  return total > 0 && r.relays.every((x) => !x.ok) && r.gateways.every((x) => !x.ok);
}

/** Should Tor be switched on automatically after this check? */
export function shouldAutoEnableTor(settings: NetSettings, r: Reachability, online: boolean): boolean {
  return online && settings.autoTor && !settings.torEnabled && allUnreachable(r);
}

export interface TransportConfig {
  /** "blocked": Tor is wanted but not connected yet; requests fail instead of leaking out directly. */
  mode: "direct" | "tor" | "blocked";
  socksPort?: number;
  doh: boolean;
}

/** The native network configuration for the current state. */
export function transportConfig(settings: NetSettings, tor: TorStatus): TransportConfig {
  if (!settings.torEnabled) return { mode: "direct", doh: true };
  if (tor.state === "on" && tor.socksPort > 0) return { mode: "tor", socksPort: tor.socksPort, doh: false };
  return { mode: "blocked", doh: false };
}

export interface Probes {
  /** Resolve true if the relay accepts a WebSocket connection within the timeout. */
  relay(url: string, timeoutMs: number): Promise<boolean>;
  /** Resolve true if the gateway answers a request within the timeout. */
  gateway(url: string, network: "ipfs" | "arweave", timeoutMs: number): Promise<boolean>;
}

/** The empty identity CID: every IPFS gateway can answer it without fetching anything. */
export const PROBE_CID = "bafkqaaa";

export async function checkReachability(
  probes: Probes,
  relays: string[],
  gateways: { url: string; network: "ipfs" | "arweave" }[],
  timeoutMs = 8000,
): Promise<Reachability> {
  const [r, g] = await Promise.all([
    Promise.all(relays.map(async (url) => ({ url, ok: await probes.relay(url, timeoutMs).catch(() => false) }))),
    Promise.all(
      gateways.map(async (gw) => ({
        url: gw.url,
        ok: await probes.gateway(gw.url, gw.network, timeoutMs).catch(() => false),
      })),
    ),
  ]);
  return { relays: r, gateways: g, at: Date.now() };
}
