export const STORY_SCHEMA = "azaadawaaz/story@1" as const;

export type Lang = "en" | "hi";
export type StoryLanguage = Lang | "both";

/** Text in one or both languages. Which keys are required depends on the story's `language`. */
export interface LocalizedText {
  en?: string;
  hi?: string;
}

/** Image size variants by width in pixels, each an IPFS CID. */
export type ImageVariants = Partial<Record<"480" | "960" | "1600", string>>;

export interface ImageItem {
  /** SHA-256 of the original (metadata-stripped) file; published byte-for-byte as approved. */
  sha256: string;
  // Derived after approval:
  cid: string;
  width: number;
  height: number;
  blurhash: string;
  variants?: ImageVariants;
  caption?: LocalizedText;
}

export interface Cover {
  sha256: string;
  // Derived after approval:
  cid: string;
  variants?: ImageVariants;
  width?: number;
  height?: number;
  blurhash?: string;
}

export interface FileRef {
  cid: string;
  sha256: string;
}

export interface TextBlock {
  type: "text";
  markdown: LocalizedText;
}

export interface ImageBlock {
  type: "image";
  items: ImageItem[];
}

export interface VideoBlock {
  type: "video";
  /** The original upload; not published, but its hash is what the moderator approved. */
  source: { sha256: string };
  title?: LocalizedText;
  description?: LocalizedText;
  // Derived after approval:
  /** IPFS path to the HLS master playlist, e.g. "bafy.../master.m3u8". */
  hls: string;
  mp4: FileRef;
  poster: FileRef;
  preview?: FileRef;
  magnet?: string;
  durationSec: number;
}

export interface EmbedStoryBlock {
  type: "embed-story";
  storyId: string;
  /** Pin a specific version; omit to show the latest. */
  version?: number;
}

export type Block = TextBlock | ImageBlock | VideoBlock | EmbedStoryBlock;

export interface Contributor {
  pubkey: string; // npub
  displayName: string;
}

export interface Approval {
  moderator: string; // npub
  approvedAt: string; // RFC 3339, UTC
  /** BIP-340 Schnorr signature (hex) over the approval message; see `approvalMessageHash`. */
  signature: string;
}

export interface Manifest {
  schema: typeof STORY_SCHEMA;
  id: string;
  version: number;
  /** SHA-256 of the previous version's manifest, or null for version 1. */
  supersedes: string | null;
  language: StoryLanguage;
  title: LocalizedText;
  summary: LocalizedText;
  cover?: Cover;
  tags: string[];
  location?: LocalizedText;
  contributor: Contributor;
  blocks: Block[];
  approval: Approval;
  publishedAt: string;
  publisher: string; // npub
}

// --- The approval body: what a moderator sees and signs (spec §4.2) ---

export interface ApprovalImageItem {
  sha256: string;
  caption?: LocalizedText;
}

export type ApprovalBlock =
  | TextBlock
  | { type: "image"; items: ApprovalImageItem[] }
  | { type: "video"; source: { sha256: string }; title?: LocalizedText; description?: LocalizedText }
  | EmbedStoryBlock;

export interface ApprovalBody {
  schema: typeof STORY_SCHEMA;
  id: string;
  version: number;
  supersedes: string | null;
  language: StoryLanguage;
  title: LocalizedText;
  summary: LocalizedText;
  cover?: { sha256: string };
  tags: string[];
  location?: LocalizedText;
  contributor: Contributor;
  blocks: ApprovalBlock[];
}
