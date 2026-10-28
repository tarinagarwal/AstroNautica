import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIND_APP_DATA, createListEvent, type Event, type Filter } from "@azaadawaaz/core";
import { describe, expect, it } from "vitest";
import { ListsService, type RelayQuery } from "../src/lists.js";
import { newActor } from "./helpers.js";

/** A fake relay set: answers queries from a list of events with real filter semantics for authors/kinds/#d. */
class FakeRelays implements RelayQuery {
  queries: Filter[] = [];
  constructor(public events: Event[]) {}
  async query(_relays: string[], f: Filter): Promise<Event[]> {
    this.queries.push(f);
    return this.events.filter(
      (e) =>
        (!f.kinds || f.kinds.includes(e.kind)) &&
        (!f.authors || f.authors.includes(e.pubkey)) &&
        (!f["#d"] || e.tags.some((t) => t[0] === "d" && f["#d"]!.includes(t[1]!))),
    );
  }
}

describe("ListsService", () => {
  it("loads owner lists, then the lists of the moderators they name, from relays", async () => {
    const [owner, mod, pub] = await Promise.all([newActor(), newActor(), newActor()]);
    const t = Math.floor(Date.now() / 1000) - 100;
    const relays = new FakeRelays([
      createListEvent(
        "moderators",
        [{ pubkey: mod.kp.pubkey, x25519: mod.x.publicKey, from: t }],
        owner.kp.secretKey,
        t,
      ),
      createListEvent(
        "service-keys",
        [
          { role: "owner", pubkey: owner.kp.pubkey, x25519: owner.x.publicKey, from: t },
          { role: "publisher", pubkey: pub.kp.pubkey, x25519: pub.x.publicKey, from: t },
        ],
        owner.kp.secretKey,
        t,
      ),
      createListEvent("relays", [{ url: "wss://own.example", operator: "own" }], owner.kp.secretKey, t),
      createListEvent("revoked-contributors", [["c".repeat(64), t]], mod.kp.secretKey, t),
    ]);
    const lists = new ListsService({ ownerPubkey: owner.kp.pubkey, relays: ["ws://seed"], pool: relays });
    expect(lists.ready()).toBe(false);
    await lists.refresh();
    expect(lists.ready()).toBe(true);
    expect(relays.queries).toHaveLength(2);
    expect(relays.queries[0]!.authors).toEqual([owner.kp.pubkey]);
    expect(relays.queries[1]!.authors).toEqual([mod.kp.pubkey]);
    expect(relays.queries[0]!.kinds).toEqual([KIND_APP_DATA]);
    expect(lists.isModerator(mod.kp.pubkey)).toBe(true);
    expect(lists.isModerator(owner.kp.pubkey)).toBe(true);
    expect(lists.isModerator(pub.kp.pubkey)).toBe(false);
    expect(lists.requiredRecipients().sort()).toEqual([owner.x.publicKey, mod.x.publicKey].sort());
    expect(lists.publisher()?.pubkey).toBe(pub.kp.pubkey);
    expect(lists.ownRelays()).toEqual(["wss://own.example"]);
    expect(lists.current().revokedContributors.has("c".repeat(64))).toBe(true);
    expect(lists.x25519For(mod.kp.pubkey)).toBe(mod.x.publicKey);
  });

  it("keeps the newest list, ignores forged or foreign events, and survives relay failures", async () => {
    const [owner, mod, mallory] = await Promise.all([newActor(), newActor(), newActor()]);
    const t = Math.floor(Date.now() / 1000) - 100;
    const lists = new ListsService({
      ownerPubkey: owner.kp.pubkey,
      relays: ["ws://seed"],
      pool: { query: () => Promise.reject(new Error("offline")) },
      log: { info: () => {}, warn: () => {} },
    });
    const v1 = createListEvent(
      "moderators",
      [{ pubkey: mod.kp.pubkey, x25519: mod.x.publicKey, from: t }],
      owner.kp.secretKey,
      t,
    );
    const v2 = createListEvent("moderators", [], owner.kp.secretKey, t + 10);
    const forged = { ...v1, created_at: t + 20 };
    const fromMallory = createListEvent(
      "moderators",
      [{ pubkey: mallory.kp.pubkey, x25519: mallory.x.publicKey, from: t }],
      mallory.kp.secretKey,
      t + 30,
    );
    expect(lists.feed([v2, v1, forged, fromMallory])).toBeGreaterThan(0);
    expect(lists.isModerator(mod.kp.pubkey)).toBe(false);
    expect(lists.isModerator(mallory.kp.pubkey)).toBe(false);
    await lists.refresh(); // offline: keeps what it has
    expect(lists.current().moderators).toEqual([]);
  });

  it("loads a bootstrap file of signed events (offline start)", async () => {
    const owner = await newActor();
    const dir = await mkdtemp(join(tmpdir(), "api-lists-"));
    try {
      const t = Math.floor(Date.now() / 1000) - 10;
      const file = join(dir, "lists.json");
      await writeFile(
        file,
        JSON.stringify([
          createListEvent("moderators", [], owner.kp.secretKey, t),
          createListEvent(
            "service-keys",
            [{ role: "owner", pubkey: owner.kp.pubkey, x25519: owner.x.publicKey, from: t }],
            owner.kp.secretKey,
            t,
          ),
        ]),
      );
      const lists = new ListsService({ ownerPubkey: owner.kp.pubkey });
      expect(await lists.loadBootstrap(file)).toBe(2);
      expect(lists.ready()).toBe(true);
      expect(lists.ownerX25519()).toBe(owner.x.publicKey);
      await writeFile(file, "{}");
      await expect(lists.loadBootstrap(file)).rejects.toThrow(/JSON array/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
