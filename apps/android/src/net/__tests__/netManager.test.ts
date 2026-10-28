import {
  DEFAULT_NET_SETTINGS,
  allUnreachable,
  checkReachability,
  shouldAutoEnableTor,
  transportConfig,
  type Reachability,
} from "../netManager";

const r = (relays: boolean[], gateways: boolean[]): Reachability => ({
  relays: relays.map((ok, i) => ({ url: `wss://r${i}`, ok })),
  gateways: gateways.map((ok, i) => ({ url: `https://g${i}`, ok })),
  at: 0,
});

describe("transport selection", () => {
  it("switches Tor on only when every relay and gateway failed", () => {
    expect(allUnreachable(r([false, false], [false]))).toBe(true);
    expect(allUnreachable(r([false, true], [false]))).toBe(false);
    expect(allUnreachable(r([], []))).toBe(false);
    expect(shouldAutoEnableTor(DEFAULT_NET_SETTINGS, r([false], [false]), true)).toBe(true);
    expect(shouldAutoEnableTor({ ...DEFAULT_NET_SETTINGS, autoTor: false }, r([false], [false]), true)).toBe(false);
    expect(shouldAutoEnableTor({ ...DEFAULT_NET_SETTINGS, torEnabled: true }, r([false], [false]), true)).toBe(false);
    expect(shouldAutoEnableTor(DEFAULT_NET_SETTINGS, r([false], [false]), false)).toBe(false);
  });

  it("never sends traffic directly while Tor is wanted but not connected", () => {
    const off = { state: "off" as const, socksPort: 0, bootstrap: 0 };
    expect(transportConfig(DEFAULT_NET_SETTINGS, off)).toEqual({ mode: "direct", doh: true });
    expect(transportConfig({ ...DEFAULT_NET_SETTINGS, torEnabled: true }, { ...off, state: "starting" })).toEqual({
      mode: "blocked",
      doh: false,
    });
    expect(
      transportConfig({ ...DEFAULT_NET_SETTINGS, torEnabled: true }, { state: "on", socksPort: 9150, bootstrap: 100 }),
    ).toEqual({ mode: "tor", socksPort: 9150, doh: false });
  });

  it("probes relays and gateways", async () => {
    const res = await checkReachability(
      { relay: async (u) => u.includes("ok"), gateway: async (_u, n) => n === "arweave" },
      ["wss://ok.example", "wss://down.example"],
      [
        { url: "https://ipfs.example", network: "ipfs" },
        { url: "https://ar.example", network: "arweave" },
      ],
    );
    expect(res.relays.map((x) => x.ok)).toEqual([true, false]);
    expect(res.gateways.map((x) => x.ok)).toEqual([false, true]);
  });
});
