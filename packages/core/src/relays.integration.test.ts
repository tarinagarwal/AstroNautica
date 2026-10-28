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
