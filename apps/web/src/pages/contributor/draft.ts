/** The contributor's local draft (kept in IndexedDB) and its projection onto the approval body moderators sign. */
import {
  STORY_SCHEMA,
  uuidv7,
  validateApprovalBody,
  DEFAULT_LIMITS,
  type ApprovalBlock,
  type ApprovalBody,
  type Lang,
  type Limits,
  type LocalizedText,
  type StoryLanguage,
  type ValidationResult,
} from "@azaadawaaz/schema";
import { idbDel, idbGet, idbKeys, idbSet } from "../../lib/idb.js";

export interface Bilingual {
  en: string;
  hi: string;
}

export const emptyText = (): Bilingual => ({ en: "", hi: "" });

export interface DraftMedia {
  sha256: string;
  mime: string;
  size: number;
  kind: "image" | "video";
  name: string;
}

export type DraftBlock =
  | { type: "text"; markdown: Bilingual }
  | { type: "image"; items: { sha256: string; caption: Bilingual }[] }
  | { type: "video"; sha256: string; title: Bilingual; description: Bilingual }
  | { type: "embed-story"; storyId: string; version: string };

export interface Draft {
  storyId: string;
  version: number;
  supersedes: string | null;
  language: StoryLanguage;
  title: Bilingual;
  summary: Bilingual;
  location: Bilingual;
  tags: string[];
  displayName: string;
  coverSha: string | null;
  blocks: DraftBlock[];
  media: Record<string, DraftMedia>;
  /** Server submission id once created. */
  submissionId?: string;
  updatedAt: number;
}

export const DEFAULT_DISPLAY_NAME = "AzaadAwaaz contributor";

export function newDraft(): Draft {
  return {
    storyId: uuidv7(),
    version: 1,
    supersedes: null,
    language: "en",
    title: emptyText(),
    summary: emptyText(),
    location: emptyText(),
    tags: [],
    displayName: "",
    coverSha: null,
    blocks: [],
    media: {},
    updatedAt: Date.now(),
  };
}

/** A correction (spec §6.5): same story id, next version, `supersedes` = the published manifest's hash. */
export function correctionOf(d: Draft, publishedVersion: number, publishedManifestSha: string): Draft {
  return {
    ...structuredClone(d),
    version: publishedVersion + 1,
    supersedes: publishedManifestSha,
    submissionId: undefined,
    updatedAt: Date.now(),
  };
}

const langsOf = (l: StoryLanguage): Lang[] => (l === "both" ? ["en", "hi"] : [l]);

function localized(t: Bilingual, language: StoryLanguage, opts: { required: boolean }): LocalizedText | undefined {
  const out: LocalizedText = {};
  for (const l of langsOf(language)) {
    const v = t[l].trim();
    if (v || opts.required) out[l] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Build the approval body (what moderators see and sign) from a draft. */
export function buildApprovalBody(d: Draft, contributorNpub: string): ApprovalBody {
  const L = d.language;
  const blocks: ApprovalBlock[] = d.blocks.map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text", markdown: localized(b.markdown, L, { required: true })! };
      case "image":
        return {
          type: "image",
          items: b.items.map((i) => {
            const caption = localized(i.caption, L, { required: false });
            return caption ? { sha256: i.sha256, caption } : { sha256: i.sha256 };
          }),
        };
      case "video": {
        const v: ApprovalBlock = { type: "video", source: { sha256: b.sha256 } };
        const title = localized(b.title, L, { required: false });
        const description = localized(b.description, L, { required: false });
        if (title) v.title = title;
        if (description) v.description = description;
        return v;
      }
      case "embed-story": {
        const version = Number(b.version);
        return b.version.trim() && Number.isInteger(version)
          ? { type: "embed-story", storyId: b.storyId.trim(), version }
          : { type: "embed-story", storyId: b.storyId.trim() };
      }
    }
  });
  const body: ApprovalBody = {
    schema: STORY_SCHEMA,
    id: d.storyId,
    version: d.version,
    supersedes: d.supersedes,
    language: L,
    title: localized(d.title, L, { required: true })!,
    summary: localized(d.summary, L, { required: true })!,
    tags: d.tags.map((t) => t.trim()).filter(Boolean),
    contributor: { pubkey: contributorNpub, displayName: d.displayName.trim() || DEFAULT_DISPLAY_NAME },
    blocks,
  };
  const location = localized(d.location, L, { required: false });
  if (location) body.location = location;
  if (d.coverSha) body.cover = { sha256: d.coverSha };
  return body;
}

export function validateDraft(d: Draft, npub: string, limits: Limits = DEFAULT_LIMITS): ValidationResult {
  return validateApprovalBody(buildApprovalBody(d, npub), limits);
}

/** Media referenced by the draft (cover, gallery items, videos), each once. */
export function usedMedia(d: Draft): DraftMedia[] {
  const shas = new Set<string>();
  if (d.coverSha) shas.add(d.coverSha);
  for (const b of d.blocks) {
    if (b.type === "image") b.items.forEach((i) => shas.add(i.sha256));
    if (b.type === "video") shas.add(b.sha256);
  }
  return [...shas].map((s) => d.media[s]).filter((m): m is DraftMedia => !!m);
}

// ---- storage ----

export const saveDraft = (d: Draft) => idbSet(`draft:${d.storyId}:${d.version}`, { ...d, updatedAt: Date.now() });
export const loadDraft = (storyId: string, version: number) => idbGet<Draft>(`draft:${storyId}:${version}`);
export const deleteDraft = (d: Draft) => idbDel(`draft:${d.storyId}:${d.version}`);

export async function listDrafts(): Promise<Draft[]> {
  const keys = await idbKeys("draft:");
  const out: Draft[] = [];
  for (const k of keys) {
    const d = await idbGet<Draft>(k);
    if (d) out.push(d);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Stripped media bytes live in IndexedDB as Blobs until the submission is uploaded. */
export const saveMediaBytes = (sha: string, bytes: Uint8Array, mime: string) =>
  idbSet(`media:${sha}`, new Blob([bytes as BlobPart], { type: mime }));

export async function loadMediaBytes(sha: string): Promise<Uint8Array | undefined> {
  const b = await idbGet<Blob | Uint8Array>(`media:${sha}`);
  if (!b) return undefined;
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(await b.arrayBuffer());
}
