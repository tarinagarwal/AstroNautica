import { buildEffectiveLists, selectStories } from "@azaadawaaz/core";
import { MediaStore } from "../../data/media";
import { GatewayClient } from "../../data/gateways";
import { JsonStore } from "../../platform/kv";
import { fakeHttp, nodeFs } from "../../test/nodePlatform";
import { GATEWAY, gatewayHandler, owner, ownerLists, publishStory } from "../../test/fixtures";
import { OfflineStore } from "../store";

describe("save for offline", () => {
  it("downloads and verifies every file, then reads offline with re-verification", async () => {
    const fs = nodeFs();
    const story = publishStory();
    const http = fakeHttp(gatewayHandler(story.files, { tamper: new Set([GATEWAY]) }), fs);
    const gateways = new GatewayClient(http);
    const lists = buildEffectiveLists(owner.pubkey, ownerLists());
    gateways.setGateways(lists.gateways);
    const media = new MediaStore(fs, http, gateways);
    const store = new OfflineStore(fs, new JsonStore(fs, "offline"));
    media.setOfflineLookup((k) => store.lookup(k));
    const ref = selectStories([story.event], lists)[0]!;
    const entry = await store.save({
      ref,
      manifest: story.manifest,
      manifestBytes: story.bytes,
      storageEvents: [story.receipt],
      includeVideo: true,
      fetchFile: (sha, info) =>
        info.kind === "video"
          ? media.video({ sha256: sha, cid: info.cid! })
          : media.original({ sha256: sha, cid: info.cid }),
    });
    expect(entry.files).toHaveLength(3);
    expect(gateways.flaggedSources()).toContain(GATEWAY);
    expect(await store.isSaved(story.manifest.id)).toBe(true);
    // offline: the media store answers from the saved copy without any request
    const before = http.requests.length;
    const p = await media.image(story.manifest.cover!, "960");
    expect(p).toContain("/offline/");
    expect(http.requests.length).toBe(before);
    const opened = await store.open(story.manifest.id, lists);
    expect(opened.check.ok).toBe(true);
    await store.remove(story.manifest.id);
    expect(await store.list()).toEqual([]);
  });
});
