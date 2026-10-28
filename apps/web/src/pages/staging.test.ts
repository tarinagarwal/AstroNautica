// @vitest-environment node
// Staging crypto (libsodium) runs in the Node environment: jsdom mixes typed arrays from two realms.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildEffectiveLists,
  decryptJson,
  unwrapKey,
  verifyApprovalSignature,
  KIND_AUDIT,
  generateKeyPair,
} from "@azaadawaaz/core";
import { findMetadata } from "@azaadawaaz/media-strip";
import { approvalBodySha256, sha256Hex, validateApprovalBody } from "@azaadawaaz/schema";
import { Api } from "../lib/api.js";
import { localSigner } from "../lib/signer.js";
import { idbReset } from "../lib/idb.js";
import { createWorld, type World } from "../test/world.js";
import { TEST_URLS } from "../test/fakes.js";
import { mockApi } from "../test/mockApi.js";
import { buildApprovalBody, emptyText, newDraft, saveMediaBytes, type Draft } from "./contributor/draft.js";
import { MediaRejectedError, prepareMedia } from "./contributor/mediaPrep.js";
import { uploadAndSubmit, type UploadProgress } from "./contributor/upload.js";
import { stagingRecipients, RecipientsError } from "../data/recipients.js";
import { decryptMedia, openSubmission, PreviewError } from "./moderator/preview.js";
import { approve, decide, publisherX25519, PublisherKeyError } from "./moderator/actions.js";

const FIX = "/home/user/AstroNautica/packages/media-strip/test/fixtures/";
const fixture = (n: string) => new Blob([readFileSync(FIX + n)]);
const LIMITS = { maxImageBytes: 20 * 1024 * 1024, maxVideoBytes: 2 * 1024 * 1024 * 1024 };
/** Stands in for the browser canvas (jsdom has none): returns a plain JPEG, as a canvas export would. */
const fakeCanvas = async () => new Uint8Array(readFileSync(FIX + "progressive.jpg"));

let world: World;

beforeEach(async () => {
  await idbReset();
  await new Promise<void>((r) => {
    const req = indexedDB.deleteDatabase("azaadawaaz");
    req.onsuccess = req.onerror = req.onblocked = () => r();
  });
  world = await createWorld(TEST_URLS);
});

describe("on-device metadata stripping", () => {
  it("removes GPS/Exif/XMP/IPTC from a JPEG and re-checks the output", async () => {
    const before = findMetadata(readFileSync(FIX + "gps.jpg"), "image/jpeg");
    expect(before).toContain("gps");
    const m = await prepareMedia(fixture("gps.jpg"), LIMITS, fakeCanvas);
    expect(m.kind).toBe("image");
    expect(findMetadata(m.bytes, m.mime).filter((f) => f !== "icc")).toEqual([]);
    expect(m.sha256).toBe(sha256Hex(m.bytes));
  });

  it("strips PNG text/eXIf and MP4 location atoms losslessly", async () => {
    const png = await prepareMedia(fixture("gps.png"), LIMITS, fakeCanvas);
    expect(findMetadata(png.bytes, png.mime).filter((f) => f !== "icc")).toEqual([]);
    const mp4 = await prepareMedia(fixture("phone.mp4"), LIMITS, fakeCanvas);
    expect(mp4.kind).toBe("video");
    expect(findMetadata(mp4.bytes, mp4.mime)).toEqual([]);
  });

  it("converts formats it can't strip (AVIF/HEIC) through the canvas to JPEG", async () => {
    const m = await prepareMedia(fixture("sample.avif"), LIMITS, fakeCanvas);
    expect(m.mime).toBe("image/jpeg");
  });

  it("refuses files that are too large", async () => {
    await expect(
      prepareMedia(fixture("gps.jpg"), { maxImageBytes: 100, maxVideoBytes: 100 }, fakeCanvas),
    ).rejects.toBeInstanceOf(MediaRejectedError);
  });
});

async function draftWithMedia(): Promise<{
  draft: Draft;
  big: Uint8Array;
  photo: Awaited<ReturnType<typeof prepareMedia>>;
}> {
  const photo = await prepareMedia(fixture("gps.png"), LIMITS, fakeCanvas);
  await saveMediaBytes(photo.sha256, photo.bytes, photo.mime);
  // A 2.5 MiB "video" so the upload spans three 1 MiB chunks.
  const big = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 31) % 256);
  const bigSha = sha256Hex(big);
  await saveMediaBytes(bigSha, big, "video/mp4");
  const d = newDraft();
  d.language = "both";
  d.title = { en: "Night of the flood", hi: "बाढ़ की रात" };
  d.summary = { en: "Residents describe it.", hi: "निवासी बताते हैं।" };
  d.tags = ["floods"];
  d.coverSha = photo.sha256;
  d.media = {
    [photo.sha256]: { sha256: photo.sha256, mime: photo.mime, size: photo.bytes.length, kind: "image", name: "a.png" },
    [bigSha]: { sha256: bigSha, mime: "video/mp4", size: big.length, kind: "video", name: "v.mp4" },
  };
  d.blocks = [
    { type: "text", markdown: { en: "It started at **midnight**.", hi: "यह **आधी रात** को शुरू हुआ।" } },
    { type: "image", items: [{ sha256: photo.sha256, caption: { en: "Street", hi: "गली" } }] },
    { type: "video", sha256: bigSha, title: { en: "Interview", hi: "" }, description: emptyText() },
    { type: "embed-story", storyId: "01928f3e-0000-7000-8000-000000000001", version: "" },
  ];
  return { draft: d, big, photo };
}

describe("contributor → moderator staging flow", () => {
  it("builds a valid approval body for every block type", async () => {
    const { draft } = await draftWithMedia();
    const c = generateKeyPair();
    const body = buildApprovalBody(draft, c.npub);
    expect(validateApprovalBody(body)).toEqual({ ok: true });
    expect(body.blocks[2]).toEqual({
      type: "video",
      source: { sha256: expect.any(String) },
      title: { en: "Interview" },
    });
    expect(body.contributor.displayName).toBe("AzaadAwaaz contributor");
  });

  it("encrypts, uploads in chunks with resume, and a moderator decrypts, previews and approves", async () => {
    const lists = buildEffectiveLists(world.owner.pubkey, world.listEvents);
    const contributor = localSigner(generateKeyPair().secretKey);
    const server = mockApi(world);
    const api = new Api(server.base, contributor, server.fetch);
    const { draft, big, photo } = await draftWithMedia();
    // The second chunk of the video fails once: the first attempt throws, the second resumes.
    server.failNextChunk(1, sha256Hex(big));
    const progress: UploadProgress[] = [];
    await expect(uploadAndSubmit(draft, contributor.npub, api, lists, (p) => progress.push(p))).rejects.toThrow();
    const id = [...server.subs.keys()][0]!;
    expect(server.subs.get(id)!.state).toBe("draft");
    const before = server.subs.get(id)!.media.find((m) => m.sha256 === sha256Hex(big))!.parts.size;
    expect(before).toBe(1);
    await uploadAndSubmit(draft, contributor.npub, api, lists, (p) => progress.push(p));
    expect(server.subs.size).toBe(1);
    const stored = server.subs.get(id)!;
    expect(stored.state).toBe("submitted");
    expect(stored.media.find((m) => m.sha256 === sha256Hex(big))!.chunks).toBe(3);
    // Wrapped for the owner and every active moderator only (from signed lists).
    expect(Object.keys(stored.wrappedKeys).sort()).toEqual([world.ownerX.publicKey, world.moderatorX.publicKey].sort());
    expect(progress.at(-1)!.phase).toBe("done");

    // Moderator side.
    const mod = localSigner(world.moderator.secretKey);
    const modApi = new Api(server.base, mod, server.fetch);
    const opened = await openSubmission(modApi, id, world.moderatorX);
    expect(opened.body).toEqual(buildApprovalBody(draft, contributor.npub));
    const meta = opened.detail.media.find((m) => m.sha256 === sha256Hex(big))!;
    const blob = await decryptMedia(modApi, id, meta, opened.key);
    expect(sha256Hex(new Uint8Array(await blob.arrayBuffer()))).toBe(sha256Hex(big));
    const photoBlob = await decryptMedia(
      modApi,
      id,
      opened.detail.media.find((m) => m.sha256 === photo.sha256)!,
      opened.key,
    );
    expect(photoBlob.type).toBe(photo.mime);

    const pk = await publisherX25519(lists, modApi);
    const sent = await approve(modApi, opened, world.moderator.secretKey, pk);
    expect(verifyApprovalSignature(opened.body, sent.approval)).toBe(true);
    expect(sent.approvalBodySha256).toBe(approvalBodySha256(opened.body));
    // The publisher (and only it) can now open the submission.
    const publisherKey = await unwrapKey(sent.publisherWrappedKey, world.publisherX);
    expect(await decryptJson(stored.bodyCiphertext, publisherKey)).toEqual(opened.body);
    expect(sent.auditEvent.kind).toBe(KIND_AUDIT);
    expect(sent.auditEvent.tags).toEqual([
      ["action", "approve"],
      ["s", sha256Hex(id)],
      ["story", opened.body.id],
    ]);
    expect(server.subs.get(id)!.state).toBe("approved");
  });

  it("request changes: feedback is NIP-44 encrypted to the contributor, then edited and resubmitted", async () => {
    const lists = buildEffectiveLists(world.owner.pubkey, world.listEvents);
    const contributor = localSigner(generateKeyPair().secretKey);
    const server = mockApi(world);
    const api = new Api(server.base, contributor, server.fetch);
    const { draft } = await draftWithMedia();
    const id = await uploadAndSubmit(draft, contributor.npub, api, lists, () => {});
    const mod = localSigner(world.moderator.secretKey);
    const modApi = new Api(server.base, mod, server.fetch);
    await decide(modApi, await openSubmission(modApi, id, world.moderatorX), mod, "changes", "Please blur the faces.");
    const mine = await api.mySubmissions();
    expect(mine[0]!.state).toBe("changes_requested");
    const fb = mine[0]!.feedback![0]!;
    expect(fb.nip44).not.toContain("blur");
    expect(await contributor.nip44Decrypt(fb.moderator, fb.nip44)).toBe("Please blur the faces.");
    expect(server.audit.at(-1)!.tags[0]).toEqual(["action", "request_changes"]);
    // Edit and resubmit the same submission.
    const edited = {
      ...draft,
      submissionId: id,
      title: { en: "Night of the flood (edited)", hi: "बाढ़ की रात (संपादित)" },
    };
    await uploadAndSubmit(edited, contributor.npub, api, lists, () => {});
    expect(server.subs.size).toBe(1);
    const reopened = await openSubmission(modApi, id, world.moderatorX);
    expect(reopened.body.title.en).toBe("Night of the flood (edited)");
  });

  it("refuses to approve when the API advertises a different publisher key than the signed list", async () => {
    const lists = buildEffectiveLists(world.owner.pubkey, world.listEvents);
    const server = mockApi(world);
    const evil = { ...world, publisherX: { publicKey: "11".repeat(32), privateKey: "22".repeat(32) } };
    const lying = mockApi(evil);
    const api = new Api(lying.base, localSigner(world.moderator.secretKey), lying.fetch);
    await expect(publisherX25519(lists, api)).rejects.toBeInstanceOf(PublisherKeyError);
    expect(
      await publisherX25519(lists, new Api(server.base, localSigner(world.moderator.secretKey), server.fetch)),
    ).toBe(world.publisherX.publicKey);
  });

  it("refuses a submission whose encrypted body describes a different story", async () => {
    const lists = buildEffectiveLists(world.owner.pubkey, world.listEvents);
    const contributor = localSigner(generateKeyPair().secretKey);
    const server = mockApi(world);
    const { draft } = await draftWithMedia();
    const id = await uploadAndSubmit(
      draft,
      contributor.npub,
      new Api(server.base, contributor, server.fetch),
      lists,
      () => {},
    );
    server.subs.get(id)!.version = 2;
    const modApi = new Api(server.base, localSigner(world.moderator.secretKey), server.fetch);
    await expect(openSubmission(modApi, id, world.moderatorX)).rejects.toBeInstanceOf(PreviewError);
  });

  it("needs the owner's and moderators' X25519 keys from the signed lists", () => {
    const lists = buildEffectiveLists(
      world.owner.pubkey,
      world.listEvents.filter((e) => !e.content.includes('"service-keys"')),
    );
    expect(() => stagingRecipients(lists)).toThrow(RecipientsError);
  });
});
