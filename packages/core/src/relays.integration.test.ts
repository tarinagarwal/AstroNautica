import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createListEvent, generateKeyPair, RelayPool, KIND_APP_DATA } from "./index.js";

const RELAYS = (process.env.TEST_RELAYS ?? "").split(",").filter(Boolean);

describe.skipIf(RELAYS.length === 0)("RelayPool against real relays (set TEST_RELAYS)", () => {
  it("publishes to every relay, tolerates a dead one, and queries back deduplicated", async () => {
    const pool = new RelayPool({ websocketImplementation: WebSocket });
    const k = generateKeyPair();
    const e = createListEvent("relays", [{ url: "wss://x.example", operator: "own" }], k.secretKey);
    const targets = [...RELAYS, "ws://127.0.0.1:1"]; // the last one is down
    const results = await pool.publish(targets, e, 5000);
    expect(results.filter((r) => r.ok).map((r) => r.relay)).toEqual(RELAYS);
    expect(results.find((r) => r.relay === "ws://127.0.0.1:1")?.ok).toBe(false);
    const got = await pool.query(targets, { kinds: [KIND_APP_DATA], authors: [k.pubkey] }, 5000);
    expect(got.map((g) => g.id)).toEqual([e.id]);
    pool.close();
  }, 20_000);
});

describe("RelayPool against a hostile relay (no real relay needed)", () => {
  it("a forged copy from one relay cannot hide the genuine event served by another", async () => {
    const { WebSocketServer } = await import("ws");
    const k = generateKeyPair();
    const genuine = createListEvent("relays", [{ url: "wss://x.example", operator: "own" }], k.secretKey);
    const forged = { ...genuine, content: "{}", sig: "00".repeat(64) };
    const serve = (port: number, ev: unknown, delayMs: number) => {
      const wss = new WebSocketServer({ port, host: "127.0.0.1" });
      wss.on("connection", (ws) =>
        ws.on("message", (m) => {
          const msg = JSON.parse(m.toString());
          if (msg[0] !== "REQ") return;
          setTimeout(() => {
            ws.send(JSON.stringify(["EVENT", msg[1], ev]));
            ws.send(JSON.stringify(["EOSE", msg[1]]));
          }, delayMs);
        }),
      );
      return wss;
    };
    const hostile = serve(17981, forged, 0);
    const honest = serve(17982, genuine, 200);
    const pool = new RelayPool({ websocketImplementation: WebSocket });
    const got = await pool.query(
      ["ws://127.0.0.1:17981", "ws://127.0.0.1:17982"],
      { kinds: [KIND_APP_DATA], authors: [k.pubkey] },
      3000,
    );
    pool.close();
    hostile.close();
    honest.close();
    expect(got.map((e) => e.id)).toEqual([genuine.id]);
    expect(got[0]!.sig).toBe(genuine.sig);
  }, 10_000);
});
