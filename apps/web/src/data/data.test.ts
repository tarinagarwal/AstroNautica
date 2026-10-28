import { beforeEach, describe, expect, it } from "vitest";
import { createListEvent, createStoryEvent, generateKeyPair } from "@azaadawaaz/core";
import { canonicalize, manifestSha256 } from "@azaadawaaz/schema";
import { AppData } from "./appData.js";
import { verifyStory } from "./verify.js";
import { normalize } from "../config.js";
import { setFetch, flaggedSources } from "../lib/gateways.js";
import { idbReset } from "../lib/idb.js";
import { FakePool, TEST_URLS, worldFetch } from "../test/fakes.js";
import { createWorld, everyBlockStory, publishStory, textStory, worldConfig, type World } from "../test/world.js";
import { encodeFile } from "../test/unixfs-encode.js";

let world: World;

async function freshDb() {
  await idbReset();
  await new Promise<void>((r) => {
    const req = indexedDB.deleteDatabase("azaadawaaz");
    req.onsuccess = req.onerror = req.onblocked = () => r();
  });
}

async function setup(extra: (w: World) => void = () => {}) {
  await freshDb();
  world = await createWorld(TEST_URLS);
  const embedded = publishStory(world, textStory(world, "Embedded update"));
  publishStory(world, await everyBlockStory(world, embedded.manifest.id));
  extra(world);
  const pool = new FakePool([...world.listEvents, ...world.stories.flatMap((s) => [s.event, s.receipt])]);
  const fetchMock = worldFetch(world);
  setFetch(fetchMock);
  const app = new AppData(normalize({ ...worldConfig(world), listEvents: [] }), pool);
  await app.init();
  await app.refresh();
  return { app, pool, fetchMock };
}

const rpc = (w: World) => worldFetch(w) as unknown as typeof fetch;

describe("data layer", () => {
  beforeEach(() => setFetch(undefined));

  it("loads lists from relays, verifies them against the owner key, and lists stories newest first", async () => {
    const { app } = await setup();
    expect(app.listsStatus).toBe("ready");
    expect(app.lists!.activeModerators.has(world.moderator.pubkey)).toBe(true);
    expect(app.stories.map((s) => s.title)).toEqual(["Floods in the valley", "Embedded update"]);
  });

  it("ignores lists signed by anyone but the owner", async () => {
    await freshDb();
    const w = await createWorld(TEST_URLS);
    const mallory = generateKeyPair();
    const fake = createListEvent("relays", [{ url: "wss://evil.example", operator: "own" }], mallory.secretKey);
    const app = new AppData(
      normalize({ ...worldConfig(w), listEvents: [], bootstrapRelays: [TEST_URLS.relay] }),
      new FakePool([fake]),
    );
    await app.init();
    await app.refresh();
    expect(app.listsStatus).toBe("none");
    expect(app.relayUrls()).toEqual([TEST_URLS.relay]);
  });

  it("shows a 'no official lists' state when built without an owner key", async () => {
    await freshDb();
    const app = new AppData(normalize({}), new FakePool());
    await app.init();
    await app.refresh();
    expect(app.listsStatus).toBe("none");
    expect(app.stories).toEqual([]);
  });

  it("hides unlisted stories, but still finds them by id (marked unlisted)", async () => {
    const { app, pool } = await setup();
    const target = world.stories[0]!.manifest.id;
    pool.push(createListEvent("unlisted", [[target, Math.floor(Date.now() / 1000)]], world.moderator.secretKey));
    expect(app.stories.map((s) => s.storyId)).not.toContain(target);
    const found = await app.getStory(target);
    expect(found?.unlisted).toBe(true);
  });

  it("ignores stories signed by a key that isn't the publisher", async () => {
    const { app, pool } = await setup();
    const mallory = generateKeyPair();
    const m = textStory(world, "Forged");
    const forged = createStoryEvent({
      manifest: m,
      manifestCid: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      secretKey: mallory.secretKey,
    });
    pool.push(forged);
    await app.refreshStories();
    expect(app.stories.map((s) => s.title)).not.toContain("Forged");
  });

  it("caches verified manifests and lists in IndexedDB for offline use", async () => {
    const { app } = await setup();
    const ref = app.stories[0]!;
    const first = await app.loadManifest(ref);
    expect(first.check.ok).toBe(true);
    // A new session with no network at all still has lists, stories and the manifest.
    setFetch(async () => {
      throw new Error("offline");
    });
    const offline = new AppData(normalize({ ...worldConfig(world), listEvents: [] }), new FakePool());
    await offline.init();
    expect(offline.listsStatus).toBe("ready");
    expect(offline.stories.length).toBe(2);
    const again = await offline.loadManifest(offline.stories[0]!);
    expect(again.fromCache).toBe(true);
    expect(again.check.ok).toBe(true);
  });

  it("Verify is green for a genuine story: manifest, IPFS CID, Arweave and chain receipt all check out", async () => {
    const { app } = await setup();
    const r = await verifyStory(app, app.stories[0]!, () => {}, rpc(world));
    expect(r.manifest.state).toBe("ok");
    expect(r.ipfs.state).toBe("ok");
    expect(r.arweave.state).toBe("ok");
    expect(r.chains.state).toBe("ok");
    expect(r.chains.receipts[0]!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.allOk).toBe(true);
  });

  it("Verify is red and flags the source when a gateway serves a tampered manifest", async () => {
    const { app } = await setup();
    const ref = app.stories[0]!;
    const bundle = world.stories.find((s) => s.sha256 === ref.manifestSha256)!;
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(bundle.bytes).replace("two metres", "ten metres"),
    );
    // The only IPFS gateway now lies, for both the plain file and the raw block.
    setFetch(worldFetch(world, { cids: new Map([[bundle.cid, tampered]]) }));
    world.arweave.set(bundle.arweaveTx, tampered);
    const r = await verifyStory(app, ref, () => {}, rpc(world));
    expect(r.manifest.state).toBe("fail");
    expect(r.ipfs.state).toBe("fail");
    expect(r.arweave.state).toBe("fail");
    expect(r.allOk).toBe(false);
    expect(flaggedSources()).toContain(TEST_URLS.gateway);
  });

  it("Verify is red when the manifest's approval signature doesn't match its content", async () => {
    const { app, pool } = await setup((w) => {
      const m = textStory(w, "Edited after approval");
      const b = publishStory(w, m);
      // Edit the text after the moderator signed, then re-announce it with a valid publisher signature.
      const edited = structuredClone(b.manifest);
      edited.blocks = [{ type: "text", markdown: { en: "Something the moderator never saw." } }];
      const bytes = new TextEncoder().encode(canonicalize(edited));
      const e = encodeFile(bytes);
      for (const blk of e.blocks) w.blocks.set(blk.cid, blk.bytes);
      w.files.set(e.cid, bytes);
      b.event = createStoryEvent({ manifest: edited, manifestCid: e.cid, secretKey: w.publisher.secretKey });
      w.receipts.set(`${m.id}:1`, { ...w.receipts.get(`${m.id}:1`)!, sha: manifestSha256(edited), cid: e.cid });
    });
    const bad = world.stories[2]!;
    pool.push(bad.event);
    await app.refreshStories();
    const ref = app.stories.find((s) => s.storyId === bad.manifest.id)!;
    const r = await verifyStory(app, ref, () => {}, rpc(world));
    expect(r.manifest.state).toBe("fail");
    expect(r.manifest.check?.checks.approvalSignature).toBe(false);
    expect(r.allOk).toBe(false);
  });

  it("Verify is red when a chain has no receipt", async () => {
    const { app } = await setup();
    const ref = app.stories[0]!;
    world.receipts.delete(`${ref.storyId}:${ref.version}`);
    const r = await verifyStory(app, ref, () => {}, rpc(world));
    expect(r.chains.state).toBe("fail");
    expect(r.chains.receipts[0]!.error).toBe("not-found");
    expect(r.allOk).toBe(false);
  });
});
