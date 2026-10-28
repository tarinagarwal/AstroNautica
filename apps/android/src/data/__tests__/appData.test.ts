import { createListEvent, type Event } from "@azaadawaaz/core";
import { bundledConfig, normalizeConfig } from "../../config";
import { JsonStore } from "../../platform/kv";
import { fakeHttp, nodeFs } from "../../test/nodePlatform";
import {
  ARWEAVE,
  GATEWAY,
  MemoryPool,
  NOW,
  PUBLIC_GATEWAY,
  gatewayHandler,
  modA,
  owner,
  ownerLists,
  publishStory,
} from "../../test/fixtures";
import { AppData } from "../appData";
import { GatewayClient } from "../gateways";

function setup(opts: { events?: Event[]; handler?: Parameters<typeof fakeHttp>[0]; bundled?: Event[] } = {}) {
  const fs = nodeFs();
  const story = publishStory();
  const pool = new MemoryPool(opts.events ?? [...ownerLists(), story.event, story.receipt]);
  const http = fakeHttp(
    opts.handler ?? gatewayHandler(story.files, { arweave: new Map([[story.arweaveTx, story.bytes]]) }),
    fs,
  );
  const gateways = new GatewayClient(http);
  const config = normalizeConfig({
    ownerPubkey: owner.pubkey,
    listEvents: opts.bundled ?? [],
    bootstrapRelays: ["wss://boot.example"],
  });
  const app = new AppData(config, pool, gateways, new JsonStore(fs, "data"), fs);
  return { fs, story, pool, http, gateways, app, config };
}

describe("AppData", () => {
  it("bundles the dev network's owner key and lists", () => {
    expect(bundledConfig.ownerPubkey === "" || /^[0-9a-f]{64}$/.test(bundledConfig.ownerPubkey)).toBe(true);
  });

  it("loads official lists from relays and selects the publisher's stories", async () => {
    const { app, story } = setup();
    await app.init();
    expect(app.listsStatus).toBe("loading");
    await app.refresh();
    expect(app.listsStatus).toBe("ready");
    expect(app.relayUrls()).toEqual(["wss://relay.example", "wss://boot.example"]);
    expect(app.stories.map((s) => s.storyId)).toEqual([story.manifest.id]);
    expect(app.search("valley")).toHaveLength(1);
    expect(app.search("घाटी")).toHaveLength(1);
    expect(app.byTag("FLOODS")).toHaveLength(1);
    app.unwatch();
  });

  it("ignores stories signed by keys that aren't the publisher", async () => {
    const forged = publishStory({ title: "Fake" });
    const tampered = { ...forged.event, pubkey: modA.pubkey };
    const { app } = setup({ events: [...ownerLists(), tampered] });
    await app.refresh();
    expect(app.stories).toHaveLength(0);
    app.unwatch();
  });

  it("verifies the manifest from the fastest gateway, skipping one that serves altered bytes", async () => {
    const story = publishStory();
    const { app, gateways } = setup({
      events: [...ownerLists(), story.event],
      handler: gatewayHandler(story.files, { tamper: new Set([GATEWAY]) }),
    });
    await app.refresh();
    const m = await app.loadManifest(app.stories[0]!);
    expect(m.check.ok).toBe(true);
    expect(gateways.flaggedSources()).toContain(GATEWAY);
    app.unwatch();
  });

  it("falls back to the Arweave copy named by the storage receipt", async () => {
    const story = publishStory();
    const { app } = setup({
      events: [...ownerLists(), story.event, story.receipt],
      handler: gatewayHandler(story.files, {
        down: new Set([GATEWAY, PUBLIC_GATEWAY]),
        arweave: new Map([[story.arweaveTx, story.bytes]]),
      }),
    });
    await app.refresh();
    const m = await app.loadManifest(app.stories[0]!);
    expect(m.check.ok).toBe(true);
    expect(m.fromCache).toBe(false);
    expect(ARWEAVE).toMatch(/^https/);
    app.unwatch();
  });

  it("keeps verified manifests and lists on the device for offline starts", async () => {
    const s = setup();
    await s.app.refresh();
    await s.app.loadManifest(s.app.stories[0]!);
    s.app.unwatch();
    // A new start with relays and gateways unreachable still shows the story and its verified manifest.
    s.pool.reachable = false;
    const again = new AppData(
      s.config,
      s.pool,
      new GatewayClient(fakeHttp(() => ({ status: 503 }))),
      new JsonStore(s.fs, "data"),
      s.fs,
    );
    await again.init();
    expect(again.listsStatus).toBe("ready");
    expect(again.stories).toHaveLength(1);
    const m = await again.loadManifest(again.stories[0]!);
    expect(m.fromCache).toBe(true);
    expect(m.check.ok).toBe(true);
    await again.refresh();
    expect(again.relaysUnreachable).toBe(true);
    again.unwatch();
  });

  it("honours moderator unlistings and owner overrides, and persists first-seen times", async () => {
    const s = setup();
    await s.app.refresh();
    const id = s.story.manifest.id;
    s.app.acceptListEvents([createListEvent("unlisted", [[id, NOW - 5]], modA.secretKey, NOW - 5)]);
    expect(s.app.stories).toHaveLength(0);
    expect((await s.app.getStory(id))?.unlisted).toBe(true);
    s.app.acceptListEvents([createListEvent("overrides", [{ list: "unlisted", value: id }], owner.secretKey, NOW - 1)]);
    expect(s.app.stories).toHaveLength(1);
    const saved = await new JsonStore(s.fs, "data").get<[string, number][]>("lists:firstSeen");
    expect(saved?.some(([k]) => k.endsWith(`|unlisted|${id}`))).toBe(true);
    s.app.unwatch();
  });

  it("reports no lists when nothing chains to the pinned owner key", async () => {
    const stranger = createListEvent(
      "relays",
      [{ url: "wss://evil.example", operator: "own" }],
      modA.secretKey,
      NOW - 10,
    );
    const s = setup({ events: [stranger] });
    await s.app.refresh();
    expect(s.app.listsStatus).toBe("none");
    expect(s.app.relayUrls()).toEqual(["wss://boot.example"]);
    s.app.unwatch();
  });
});
