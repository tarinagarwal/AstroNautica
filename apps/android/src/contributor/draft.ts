/**
 * The block story editor's model (spec §4, §8.2): a draft holds text in one or both languages and references to
 * metadata-stripped media files on the device. `toApprovalBody` produces exactly what a moderator will see and sign.
 */
import {
  DEFAULT_LIMITS,
  STORY_SCHEMA,
  isUuidv7,
  uuidv7,
  validateApprovalBody,
  type ApprovalBlock,
  type ApprovalBody,
  type Lang,
  type LocalizedText,
  type StoryLanguage,
} from "@azaadawaaz/schema";

export interface StrippedMedia {
  /** App-private path of the metadata-stripped file. */
  path: string;
  sha256: string;
  size: number;
  /** MIME type sent to the API (image/jpeg|png|webp, video/mp4|quicktime). */
  mime: string;
  /** What the original carried (media-strip names), for the confirmation screen. */
  removed: string[];
  /** True only after the stripped output was re-read and `findMetadata` returned nothing. */
  metadataFree: boolean;
  /** Re-encoded to JPEG on the device (HEIC/AVIF/GIF input, or a rotated photo). */
  converted?: boolean;
}

export interface DraftImage {
  media: StrippedMedia;
  caption: LocalizedText;
}

export type DraftBlock =
  | { id: string; type: "text"; markdown: LocalizedText }
  | { id: string; type: "image"; items: DraftImage[] }
  | { id: string; type: "video"; video: StrippedMedia | null; title: LocalizedText; description: LocalizedText }
  | { id: string; type: "embed-story"; storyId: string; version?: number };

export interface Draft {
  localId: string;
  /** Empty until the first submission: the UUIDv7 is generated then, so it doesn't reveal when writing began. */
  storyId: string;
  version: number;
  /** Previous manifest sha256 when this is a correction (version > 1). */
  supersedes: string | null;
  language: StoryLanguage;
  title: LocalizedText;
  summary: LocalizedText;
  tags: string[];
  location: LocalizedText;
  displayName: string;
  /** sha256 of the cover image (one of the story's images, or a separate one). */
  cover: StrippedMedia | null;
  blocks: DraftBlock[];
  /** Set once the API has a submission for this draft. */
  submissionId?: string;
  updatedAt: number;
}

export interface MediaLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
  maxBlocks: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxVideoBytes: 2 * 1024 * 1024 * 1024,
  maxBlocks: DEFAULT_LIMITS.maxBlocks,
};

export const DEFAULT_DISPLAY_NAME = "AzaadAwaaz contributor";

let blockCounter = 0;
export const newBlockId = () => `b${Date.now().toString(36)}${(blockCounter++).toString(36)}`;

/** Give the draft its story id at the moment of its first submission (corrections and resubmissions keep theirs). */
export function withStoryId(d: Draft, now = Date.now()): Draft {
  return d.storyId ? d : { ...d, storyId: uuidv7(now) };
}

export function newDraft(language: StoryLanguage = "en", now = Date.now()): Draft {
  return {
    localId: `d${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    storyId: "",
    version: 1,
    supersedes: null,
    language,
    title: {},
    summary: {},
    tags: [],
    location: {},
    displayName: "",
    cover: null,
    blocks: [{ id: newBlockId(), type: "text", markdown: {} }],
    updatedAt: now,
  };
}

/** Languages the draft must carry text in. */
export const draftLangs = (l: StoryLanguage): Lang[] => (l === "both" ? ["en", "hi"] : [l]);

/** Keep only the story's languages and drop blank values; undefined when nothing is left. */
function clean(t: LocalizedText | undefined, langs: Lang[]): LocalizedText | undefined {
  if (!t) return undefined;
  const out: LocalizedText = {};
  for (const l of langs) {
    const v = t[l]?.trim();
    if (v) out[l] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The approval body for this draft: exactly what the moderator sees and signs (spec §4.2). */
export function toApprovalBody(d: Draft, contributorNpub: string): ApprovalBody {
  const langs = draftLangs(d.language);
  const blocks: ApprovalBlock[] = d.blocks.map((b): ApprovalBlock => {
    switch (b.type) {
      case "text":
        return { type: "text", markdown: clean(b.markdown, langs) ?? {} };
      case "image":
        return {
          type: "image",
          items: b.items.map((i) => {
            const caption = clean(i.caption, langs);
            return caption ? { sha256: i.media.sha256, caption } : { sha256: i.media.sha256 };
          }),
        };
      case "video": {
        const v: ApprovalBlock = { type: "video", source: { sha256: b.video?.sha256 ?? "" } };
        const title = clean(b.title, langs);
        const description = clean(b.description, langs);
        if (title) v.title = title;
        if (description) v.description = description;
        return v;
      }
      case "embed-story":
        return b.version === undefined
          ? { type: "embed-story", storyId: b.storyId.trim() }
          : { type: "embed-story", storyId: b.storyId.trim(), version: b.version };
    }
  });
  const body: ApprovalBody = {
    schema: STORY_SCHEMA,
    id: d.storyId,
    version: d.version,
    supersedes: d.supersedes,
    language: d.language,
    title: clean(d.title, langs) ?? {},
    summary: clean(d.summary, langs) ?? {},
    tags: [...new Set(d.tags.map((t) => t.trim()).filter(Boolean))],
    contributor: { pubkey: contributorNpub, displayName: d.displayName.trim() || DEFAULT_DISPLAY_NAME },
    blocks,
  };
  if (d.cover) body.cover = { sha256: d.cover.sha256 };
  const location = clean(d.location, langs);
  if (location) body.location = location;
  return body;
}

export interface DraftMedia {
  sha256: string;
  size: number;
  mime: string;
  kind: "image" | "video";
  path: string;
}

/** Every distinct media file the draft references (cover first), as the API's media list. */
export function draftMedia(d: Draft): DraftMedia[] {
  const out = new Map<string, DraftMedia>();
  const add = (m: StrippedMedia | null | undefined, kind: "image" | "video") => {
    if (m && !out.has(m.sha256)) out.set(m.sha256, { sha256: m.sha256, size: m.size, mime: m.mime, kind, path: m.path });
  };
  add(d.cover, "image");
  for (const b of d.blocks) {
    if (b.type === "image") b.items.forEach((i) => add(i.media, "image"));
    if (b.type === "video") add(b.video, "video");
  }
  return [...out.values()];
}

export interface DraftProblem {
  /** i18n key */
  key: string;
  vars?: Record<string, string | number>;
  /** schema validator message, when the problem comes from there */
  detail?: string;
}

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_MIMES = ["video/mp4", "video/quicktime"];

/** Everything that must be fixed before the draft can be submitted. Empty means ready. */
export function validateDraft(d: Draft, contributorNpub: string, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (d.storyId && !isUuidv7(d.storyId)) problems.push({ key: "editor.problem.storyId" });
  if (d.blocks.length === 0) problems.push({ key: "editor.problem.noBlocks" });
  if (d.blocks.length > limits.maxBlocks) problems.push({ key: "editor.problem.tooManyBlocks", vars: { max: limits.maxBlocks } });
  const allMedia: StrippedMedia[] = [];
  if (d.cover) allMedia.push(d.cover);
  d.blocks.forEach((b, i) => {
    const n = i + 1;
    if (b.type === "video") {
      if (!b.video) problems.push({ key: "editor.problem.videoMissing", vars: { n } });
      else allMedia.push(b.video);
    }
    if (b.type === "image") {
      if (b.items.length === 0 || b.items.length > DEFAULT_LIMITS.maxImagesPerBlock)
        problems.push({ key: "editor.problem.imageCount", vars: { n, max: DEFAULT_LIMITS.maxImagesPerBlock } });
      b.items.forEach((it) => allMedia.push(it.media));
    }
  });
  for (const m of allMedia) {
    if (!m.metadataFree) problems.push({ key: "editor.problem.metadata" });
    const isVideo = VIDEO_MIMES.includes(m.mime);
    if (!isVideo && !IMAGE_MIMES.includes(m.mime)) problems.push({ key: "editor.problem.mime", vars: { mime: m.mime } });
    const max = isVideo ? limits.maxVideoBytes : limits.maxImageBytes;
    if (m.size > max) problems.push({ key: "editor.problem.tooLarge", vars: { mb: Math.round(max / 1024 / 1024) } });
  }
  // Validate with a placeholder id when none has been assigned yet (it is generated at submission).
  const v = validateApprovalBody(toApprovalBody(d.storyId ? d : { ...d, storyId: uuidv7() }, contributorNpub));
  if (!v.ok) for (const e of v.errors) problems.push({ key: "editor.problem.schema", detail: e });
  return problems;
}

export function moveBlock(d: Draft, index: number, delta: -1 | 1): Draft {
  const j = index + delta;
  if (j < 0 || j >= d.blocks.length) return d;
  const blocks = [...d.blocks];
  [blocks[index], blocks[j]] = [blocks[j]!, blocks[index]!];
  return { ...d, blocks, updatedAt: Date.now() };
}
