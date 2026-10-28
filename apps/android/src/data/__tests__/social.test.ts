import {
  DEFAULT_POW_DIFFICULTY,
  committedPow,
  createListEvent,
  verifyEventStrict,
  type EventTemplate,
} from "@azaadawaaz/core";
import { getEventHash } from "nostr-tools/pure";
import { createHash } from "node:crypto";
import { normalizeConfig } from "../../config";
import { JsonStore } from "../../platform/kv";
import { fakeHttp, nodeFs } from "../../test/nodePlatform";
import { MemoryPool, NOW, contributor, modA, owner, ownerLists, publishStory } from "../../test/fixtures";
import { AppData } from "../appData";
import { GatewayClient } from "../gateways";
import { mineEvent, powParts, serializeForId, type NativeMiner } from "../pow";
import { StorySocial } from "../social";

/** The native miner's contract, done in Node (Kotlin's PowMiner hashes prefix + nonce + suffix the same way). */
const jsMiner: NativeMiner & { calls: number } = {
  calls: 0,
  async mine(_id, prefix, suffix, difficulty, start) {
    this.calls++;
    for (let n = start; ; n++) {
      const h = createHash("sha256")
        .update(prefix + n + suffix)
        .digest();
      let bits = 0;
      for (const b of h) {
        if (b === 0) bits += 8;
        else {
          bits += Math.clz32(b) - 24;
          break;
        }
      }
      if (bits >= difficulty) return String(n);
    }
  },
  cancel() {},
};

describe("proof-of-work", () => {
  const template: EventTemplate = {
    kind: 1111,
    created_at: NOW,
    tags: [["A", "30023:x:y"]],
    content: 'quote " and \\ and हिन्दी 🙏',
  };

  it("splits the serialisation exactly where nostr-tools puts the nonce", () => {
    const { prefix, suffix, tags } = powParts(template, contributor.pubkey, 16);
    const ev = { ...template, pubkey: contributor.pubkey, tags: tags("12345") };
    expect(prefix + "12345" + suffix).toBe(serializeForId(ev));
    expect(
      createHash("sha256")
        .update(prefix + "12345" + suffix)
        .digest("hex"),
    ).toBe(getEventHash(ev));
  });

  it("mines with the native miner and falls back to JS", async () => {
    const e = await mineEvent(template, contributor.secretKey, 12, jsMiner);
    expect(jsMiner.calls).toBe(1);
    expect(committedPow(e)).toBeGreaterThanOrEqual(12);
    expect(verifyEventStrict(e)).toBe(true);
    const broken: NativeMiner = { mine: async () => "0", cancel() {} };
    const f = await mineEvent(template, contributor.secretKey, 8, broken);
    expect(committedPow(f)).toBeGreaterThanOrEqual(8);
    const g = await mineEvent(template, contributor.secretKey, 6);
    expect(committedPow(g)).toBeGreaterThanOrEqual(6);
  });
});

describe("comments and reactions", () => {
  it("posts with PoW, threads replies, and honours hidden and muted lists", async () => {
    const fs = nodeFs();
    const story = publishStory();
    const pool = new MemoryPool([...ownerLists(), story.event]);
    const app = new AppData(
      normalizeConfig({ ownerPubkey: owner.pubkey, powDifficulty: 10 }),
      pool,
      new GatewayClient(fakeHttp(() => ({ status: 404 }))),
      new JsonStore(fs, "d"),
      fs,
    );
    await app.refresh();
    const ref = app.stories[0]!;
    const social = new StorySocial(app, ref, jsMiner);
    const c = await social.comment("First!", contributor.secretKey);
    expect(c.results.every((r) => r.ok)).toBe(true);
    const reply = await social.comment("Reply", modA.secretKey, c.event);
    await social.react("🙏", contributor.secretKey);
    let s = social.state(contributor.pubkey);
    expect(s.total).toBe(2);
    expect(s.comments[0]!.replies[0]!.event.id).toBe(reply.event.id);
    expect(s.reactions["🙏"]).toBe(1);
    expect(s.mine.has("🙏")).toBe(true);
    // a fresh reader sees the same from the relays
    const fresh = new StorySocial(app, ref);
    await fresh.load();
    expect(fresh.state().total).toBe(2);
    // a moderator hides the reply and mutes the first author
    app.acceptListEvents([
      createListEvent("hidden", [[reply.event.id, NOW]], modA.secretKey, NOW),
      createListEvent("muted", [[contributor.pubkey, NOW]], modA.secretKey, NOW),
    ]);
    s = fresh.state();
    expect(s.total).toBe(0);
    expect(s.reactions["🙏"]).toBe(0);
    expect(DEFAULT_POW_DIFFICULTY).toBe(16);
    app.unwatch();
  });
});
