/**
 * Runtime glue for the transport: drives the native Tor service and the native HTTP client's mode, persists the
 * user's choices, and runs the reachability check that switches Tor on automatically.
 */
import NativeAzaadNet from "../native/specs/NativeAzaadNet";
import NativeAzaadTor from "../native/specs/NativeAzaadTor";
import type { JsonStore } from "../platform/kv";
import { onNativeEvent } from "../platform/nativeEvents";
import { NativeWebSocket } from "../platform/nativeWebSocket";
import type { Http } from "../platform/types";
import {
  DEFAULT_NET_SETTINGS,
  PROBE_CID,
  checkReachability,
  shouldAutoEnableTor,
  transportConfig,
  type NetSettings,
  type Probes,
  type Reachability,
  type TorStatus,
} from "./netManager";

export class NetController {
  settings: NetSettings = DEFAULT_NET_SETTINGS;
  tor: TorStatus = { state: "off", socksPort: 0, bootstrap: 0 };
  reachability: Reachability | null = null;
  private readonly listeners = new Set<() => void>();
  private gateways: string[] = [];

  constructor(
    private readonly kv: JsonStore,
    private readonly http: Http,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    this.settings = { ...DEFAULT_NET_SETTINGS, ...((await this.kv.get<NetSettings>("net:settings")) ?? {}) };
    onNativeEvent<TorStatus>("azaadTor", (s) => {
      this.tor = s;
      this.apply();
      this.emit();
    });
    this.tor = JSON.parse(await NativeAzaadTor.status()) as TorStatus;
    this.apply();
    if (this.settings.torEnabled && this.tor.state === "off") await this.startTor();
    this.emit();
  }

  private apply(): void {
    NativeAzaadNet.configure(JSON.stringify(transportConfig(this.settings, this.tor)));
  }

  private async save(next: NetSettings): Promise<void> {
    this.settings = next;
    await this.kv.set("net:settings", next);
    this.apply();
    this.emit();
  }

  private async startTor(): Promise<void> {
    try {
      this.tor = JSON.parse(await NativeAzaadTor.start(JSON.stringify({ bridges: this.settings.bridges }))) as TorStatus;
    } catch (e) {
      this.tor = { state: "error", socksPort: 0, bootstrap: 0, error: e instanceof Error ? e.message : String(e) };
    }
    this.apply();
    this.emit();
  }

  async setTor(on: boolean): Promise<void> {
    await this.save({ ...this.settings, torEnabled: on, autoEnabled: false });
    if (on) await this.startTor();
    else {
      await NativeAzaadTor.stop();
      this.tor = { state: "off", socksPort: 0, bootstrap: 0 };
      this.apply();
      this.emit();
    }
  }

  async setBridges(bridges: NetSettings["bridges"]): Promise<void> {
    await this.save({ ...this.settings, bridges });
    if (this.settings.torEnabled) {
      await NativeAzaadTor.stop();
      await this.startTor();
    }
  }

  async setAutoTor(autoTor: boolean): Promise<void> {
    await this.save({ ...this.settings, autoTor });
  }

  /** Media provider (HLS) gateways, best first. */
  setMediaGateways(bases: string[]): void {
    const key = bases.join("|");
    if (key === this.gateways.join("|")) return;
    this.gateways = bases;
    NativeAzaadNet.setMediaSources(JSON.stringify({ gateways: bases }));
  }

  private probes(): Probes {
    return {
      relay: (url, timeoutMs) =>
        new Promise<boolean>((resolve) => {
          let done = false;
          const ws = new NativeWebSocket(url);
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            ws.close();
            resolve(ok);
          };
          const timer = setTimeout(() => finish(false), timeoutMs);
          ws.onopen = () => finish(true);
          ws.onerror = () => finish(false);
          ws.onclose = () => finish(false);
        }),
      gateway: async (url, network, timeoutMs) => {
        const base = url.replace(/\/+$/, "");
        const res = await this.http.request({
          url: network === "ipfs" ? `${base}/ipfs/${PROBE_CID}` : `${base}/info`,
          timeoutMs,
          maxBytes: 1024 * 1024,
        });
        return res.status >= 200 && res.status < 400;
      },
    };
  }

  /** Check relays and gateways directly; switch Tor on when nothing answers. Returns true if it did. */
  async checkAndMaybeEnableTor(relays: string[], gateways: { url: string; network: "ipfs" | "arweave" }[]): Promise<boolean> {
    if (this.settings.torEnabled) return false;
    this.reachability = await checkReachability(this.probes(), relays, gateways);
    this.emit();
    if (!shouldAutoEnableTor(this.settings, this.reachability, true)) return false;
    await this.save({ ...this.settings, torEnabled: true, autoEnabled: true });
    await this.startTor();
    return true;
  }
}
