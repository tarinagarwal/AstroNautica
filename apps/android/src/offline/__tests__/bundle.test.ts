import * as fs from "node:fs";
import * as path from "node:path";
import { zipSync, unzipSync } from "fflate";
import { buildEffectiveLists, createListEvent, createStoryEvent, generateKeyPair, type Event } from "@azaadawaaz/core";
import { canonicalize } from "@azaadawaaz/schema";
import { JsonStore } from "../../platform/kv";
import { joinPath } from "../../platform/types";
import { nodeFs, tempDir } from "../../test/nodePlatform";
import { NOW, modA, owner, ownerLists, publisher, publishStory } from "../../test/fixtures";
import { utf8 } from "../../util/bytes";
import { BundleError, exportBundle, importBundle, manifestFiles } from "../bundle";
import { OfflineStore } from "../store";
import { rawCidOf } from "../../data/ipfs";

const sender = nodeFs();
const story = publishStory();
const listEvents = [...ownerLists(), createListEvent("featured", [[story.manifest.id, NOW - 9]], modA.secretKey, NOW - 9)];
const lists = buildEffectiveLists(owner.pubkey, listEvents);
const ref = { ...((): any => {
  const { selectStories } = require("@azaadawaaz/core");
  return selectStories([story.event], lists)[0];
})() };

async function makeBundle(includeVideo: boolean, mutateFile?: (sha: string, bytes: Uint8Array) => Uint8Array): Promise<string> {
  const byCid = new Map([...story.files]);
  const bySha = new Map<string, Uint8Array>();
  for (const [sha, info] of manifestFiles(story.manifest)) bySha.set(sha, byCid.get(info.cid!)!);
  const src = joinPath(sender.paths.cache, "src");
  await sender.mkdirs(src);
  const out = joinPath(sender.paths.cache, `b-${Math.random().toString(36).slice(2)}.zip`);
  await exportBundle(
    sender,
    {
      ref,
      manifestBytes: story.bytes,
      manifest: story.manifest,
      lists,
      storage: [story.receipt],
      includeVideo,
      fetchFile: async (sha) => {
        const p = joinPath(src, sha);
        await sender.writeBytes(p, mutateFile ? mutateFile(sha, bySha.get(sha)!) : bySha.get(sha)!);
        return p;
      },
    },
    joinPath(sender.paths.cache, "work"),
    out,
  );
  return out;
}

/** Rewrite one entry of a zip (to simulate tampering in transit). */
function rewriteZip(zip: string, edit: (entries: Record<string, Uint8Array>) => void): string {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zip)));
  edit(entries);
  const out = path.join(tempDir(), "t.zip");
  fs.writeFileSync(out, zipSync(entries));
  return out;
}

const receiver = () => nodeFs();
// The receiving phone only has the app's bundled (owner-signed) lists, and nothing from the network.
const trust = { ownerPubkey: owner.pubkey, knownListEvents: ownerLists().slice(0, 2) };

describe("offline bundles", () => {
  it("round-trips a story: every signature and file verified before use", async () => {
    const zip = await makeBundle(true);
    const r = receiver();
    const b = await importBundle(r, zip, joinPath(r.paths.cache, "in"), trust);
    expect(b.check.ok).toBe(true);
    expect(b.ref.storyId).toBe(story.manifest.id);
    expect(b.missing).toEqual([]);
    expect(b.media.size).toBe(3);
    expect(b.storage[0]?.arweave[story.sha]).toBe(story.arweaveTx);
    expect(b.listEvents.length).toBeGreaterThan(0);
    expect(b.unlisted).toBe(false);
    // keep it, then open it offline with re-verification
    const store = new OfflineStore(r, new JsonStore(r, "offline"));
    const entry = await store.saveBundle(b);
    expect(entry.source).toBe("bundle");
    const opened = await store.open(story.manifest.id, buildEffectiveLists(owner.pubkey, trust.knownListEvents));
    expect(opened.check.ok).toBe(true);
    expect(await store.lookup(story.manifest.cover!.sha256)).toBeDefined();
  });

  it("reports left-out videos instead of failing", async () => {
    const r = receiver();
    const b = await importBundle(r, await makeBundle(false), joinPath(r.paths.cache, "in"), trust);
    expect(b.missing).toEqual([story.manifest.blocks[2]!.type === "video" ? (story.manifest.blocks[2] as any).mp4.sha256 : ""]);
  });

  it("refuses to export a file that doesn't match its hash", async () => {
    await expect(makeBundle(true, (sha, b) => (sha === story.manifest.cover!.sha256 ? Uint8Array.from(b, (x, i) => (i === 7 ? x ^ 1 : x)) : b))).rejects.toThrow(/changed/);
  });

  it("rejects a media file altered in transit", async () => {
    const r = receiver();
    const name = `media/${story.manifest.cover!.sha256}`;
    const zip = rewriteZip(await makeBundle(true), (e) => {
      e[name] = Uint8Array.from(e[name]!, (x, i) => (i === 7 ? x ^ 1 : x));
    });
    await expect(importBundle(r, zip, joinPath(r.paths.cache, "in"), trust)).rejects.toMatchObject({ key: "bundle.error.hash" });
  });

  it("rejects an altered manifest", async () => {
    const zip = rewriteZip(await makeBundle(false), (e) => {
      e["manifest.json"] = utf8(new TextDecoder().decode(e["manifest.json"]!).replace("What we saw", "What we sew"));
    });
    const r = receiver();
    const err = await importBundle(r, zip, joinPath(r.paths.cache, "in"), trust).catch((x) => x);
    expect(err).toBeInstanceOf(BundleError);
    expect(err.key).toBe("bundle.error.manifest");
  });

  it("rejects a story event signed by someone else and forged lists", async () => {
    // A key that isn't the publisher re-signs the story event.
    const imposter = generateKeyPair();
    const forged = createStoryEvent({ manifest: story.manifest, manifestCid: story.cid, secretKey: imposter.secretKey });
    const zip1 = rewriteZip(await makeBundle(false), (e) => {
      const ev = JSON.parse(new TextDecoder().decode(e["events.json"]!));
      ev.story = forged;
      // and ships a "service-keys" list signed by the imposter naming itself publisher
      ev.lists.push(createListEvent("service-keys", [{ role: "publisher", pubkey: imposter.pubkey, from: 0 }], imposter.secretKey, NOW));
      e["events.json"] = utf8(JSON.stringify(ev));
    });
    const r = receiver();
    await expect(importBundle(r, zip1, joinPath(r.paths.cache, "in"), trust)).rejects.toMatchObject({ key: "bundle.error.signature" });
    // An edited story event (content changed after signing) fails too.
    const zip2 = rewriteZip(await makeBundle(false), (e) => {
      const ev = JSON.parse(new TextDecoder().decode(e["events.json"]!));
      ev.story = { ...ev.story, content: "edited" } as Event;
      e["events.json"] = utf8(JSON.stringify(ev));
    });
    await expect(importBundle(r, zip2, joinPath(r.paths.cache, "in2"), trust)).rejects.toMatchObject({ key: "bundle.error.signature" });
  });

  it("rejects a manifest approved by a key that wasn't a moderator", async () => {
    const rogue = publishStory({ approver: generateKeyPair() as typeof modA });
    const zip = rewriteZip(await makeBundle(false), (e) => {
      const ev = JSON.parse(new TextDecoder().decode(e["events.json"]!));
      ev.story = rogue.event;
      const idx = JSON.parse(new TextDecoder().decode(e["azaad-bundle.json"]!));
      idx.storyId = rogue.manifest.id;
      e["azaad-bundle.json"] = utf8(JSON.stringify(idx));
      e["events.json"] = utf8(JSON.stringify(ev));
      e["manifest.json"] = rogue.bytes;
      for (const k of Object.keys(e)) if (k.startsWith("media/")) delete e[k];
    });
    const r = receiver();
    const err = await importBundle(r, zip, joinPath(r.paths.cache, "in"), trust).catch((x) => x);
    expect(err.key).toBe("bundle.error.manifest");
    expect(err.message).toMatch(/not a moderator/);
  });

  it("rejects extra files, path tricks and a mismatched index", async () => {
    const r = receiver();
    const extra = rewriteZip(await makeBundle(false), (e) => {
      e["media/" + "0".repeat(64)] = Uint8Array.from([1]);
    });
    await expect(importBundle(r, extra, joinPath(r.paths.cache, "a"), trust)).rejects.toMatchObject({ key: "bundle.error.unexpected" });
    const script = rewriteZip(await makeBundle(false), (e) => {
      e["run.sh"] = utf8("#!/bin/sh");
    });
    await expect(importBundle(r, script, joinPath(r.paths.cache, "b"), trust)).rejects.toMatchObject({ key: "bundle.error.unexpected" });
    const traversal = rewriteZip(await makeBundle(false), (e) => {
      e["../escape"] = utf8("x");
    });
    await expect(importBundle(r, traversal, joinPath(r.paths.cache, "c"), trust)).rejects.toMatchObject({ key: "bundle.error.unzip" });
    const idx = rewriteZip(await makeBundle(false), (e) => {
      const i = JSON.parse(new TextDecoder().decode(e["azaad-bundle.json"]!));
      i.version = 2;
      e["azaad-bundle.json"] = utf8(JSON.stringify(i));
    });
    await expect(importBundle(r, idx, joinPath(r.paths.cache, "d"), trust)).rejects.toMatchObject({ key: "bundle.error.mismatch" });
    const notOurs = path.join(tempDir(), "x.zip");
    fs.writeFileSync(notOurs, zipSync({ "azaad-bundle.json": utf8(canonicalize({ schema: "other" })) }));
    await expect(importBundle(r, notOurs, joinPath(r.paths.cache, "e"), trust)).rejects.toMatchObject({ key: "bundle.error.schema" });
    expect(rawCidOf(new Uint8Array(0))).toMatch(/^bafkrei/);
    expect(publisher.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});
