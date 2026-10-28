import { isUuidv7, validateApprovalBody } from "@azaadawaaz/schema";
import { contributor } from "../../test/fixtures";
import { draftMedia, moveBlock, newBlockId, newDraft, toApprovalBody, validateDraft, withStoryId, type Draft, type StrippedMedia } from "../draft";

const media = (sha: string, mime = "image/jpeg", size = 1000): StrippedMedia => ({ path: `/x/${sha}`, sha256: sha, size, mime, removed: ["gps"], metadataFree: true });

function draft(): Draft {
  const d = newDraft("both");
  return {
    ...d,
    title: { en: " Title ", hi: "शीर्षक" },
    summary: { en: "Sum", hi: "सार", extra: "x" } as never,
    tags: ["a", " a ", "", "b"],
    blocks: [
      { id: newBlockId(), type: "text", markdown: { en: "Body", hi: "पाठ" } },
      { id: newBlockId(), type: "image", items: [{ media: media("a".repeat(64)), caption: { en: "cap", hi: "कैप्शन" } }] },
      { id: newBlockId(), type: "video", video: media("b".repeat(64), "video/mp4", 5000), title: { en: "V" }, description: {} },
      { id: newBlockId(), type: "embed-story", storyId: "01928f3e-0000-7000-8000-000000000001" },
    ],
  };
}

describe("story editor model", () => {
  it("assigns the story id at submission, not when the draft starts", () => {
    const d = newDraft();
    expect(d.storyId).toBe("");
    const s = withStoryId(d);
    expect(isUuidv7(s.storyId)).toBe(true);
    expect(withStoryId(s)).toBe(s);
  });

  it("produces a schema-valid approval body with only the story's languages", () => {
    const d = withStoryId(draft());
    const body = toApprovalBody(d, contributor.npub);
    expect(validateApprovalBody(body)).toEqual({ ok: true });
    expect(body.title).toEqual({ en: "Title", hi: "शीर्षक" });
    expect(body.summary).toEqual({ en: "Sum", hi: "सार" });
    expect(body.tags).toEqual(["a", "b"]);
    expect(body.blocks[1]).toEqual({ type: "image", items: [{ sha256: "a".repeat(64), caption: { en: "cap", hi: "कैप्शन" } }] });
    expect(body.contributor.displayName).toBe("AzaadAwaaz contributor");
    expect(validateDraft(d, contributor.npub)).toEqual([]);
    expect(validateDraft(draft(), contributor.npub)).toEqual([]);
  });

  it("lists distinct media for upload", () => {
    const d = draft();
    d.cover = media("a".repeat(64));
    expect(draftMedia(d).map((m) => [m.sha256[0], m.kind])).toEqual([
      ["a", "image"],
      ["b", "video"],
    ]);
  });

  it("reports what must be fixed", () => {
    const d = draft();
    d.title = { en: "only English" };
    (d.blocks[1] as any).items[0].media = { ...media("c".repeat(64)), metadataFree: false };
    (d.blocks[2] as any).video = null;
    const keys = validateDraft(d, contributor.npub).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["editor.problem.metadata", "editor.problem.videoMissing", "editor.problem.schema"]));
    const half = draft();
    (half.blocks[1] as any).items[0].caption = { en: "only English" };
    expect(validateDraft(half, contributor.npub).some((p) => p.detail?.includes("caption.hi is required"))).toBe(true);
    const big = draft();
    (big.blocks[1] as any).items[0].media = media("d".repeat(64), "image/gif", 30 * 1024 * 1024);
    expect(validateDraft(big, contributor.npub).map((p) => p.key)).toEqual(expect.arrayContaining(["editor.problem.mime", "editor.problem.tooLarge"]));
    expect(validateDraft({ ...draft(), blocks: [] }, contributor.npub).map((p) => p.key)).toContain("editor.problem.noBlocks");
  });

  it("moves blocks", () => {
    const d = draft();
    const m = moveBlock(d, 0, 1);
    expect(m.blocks[1]!.id).toBe(d.blocks[0]!.id);
    expect(moveBlock(d, 0, -1)).toBe(d);
  });
});
