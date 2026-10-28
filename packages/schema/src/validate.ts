import { isSha256Hex } from "./hash.js";
import { STORY_SCHEMA, type ApprovalBody, type LocalizedText, type Manifest, type StoryLanguage } from "./types.js";
import { isUuidv7 } from "./uuid.js";

export interface Limits {
  maxBlocks: number;
  maxImagesPerBlock: number;
  maxTags: number;
  maxSummaryChars: number;
  maxTitleChars: number;
  maxTagChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBlocks: 100,
  maxImagesPerBlock: 20,
  maxTags: 10,
  maxSummaryChars: 300,
  maxTitleChars: 200,
  maxTagChars: 40,
};

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const NPUB = /^npub1[02-9ac-hj-np-z]{58}$/;
const CID_V1 = /^b[a-z2-7]{20,}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function isNpub(s: unknown): s is string {
  return typeof s === "string" && NPUB.test(s);
}

export function isCidV1(s: unknown): s is string {
  return typeof s === "string" && CID_V1.test(s);
}

/** Validate the parts a contributor controls: everything a moderator sees and approves. */
export function validateApprovalBody(body: unknown, limits: Limits = DEFAULT_LIMITS): ValidationResult {
  const v = new Validator(limits);
  v.body(body as ApprovalBody, false);
  return v.result();
}

/** Validate a complete published manifest, including the derived media fields and the approval. */
export function validateManifest(manifest: unknown, limits: Limits = DEFAULT_LIMITS): ValidationResult {
  const v = new Validator(limits);
  const m = manifest as Manifest;
  if (v.body(m, true)) {
    v.check(isNpub(m.publisher), "publisher must be an npub");
    v.check(isTime(m.publishedAt), "publishedAt must be an RFC 3339 UTC time");
    const a = m.approval;
    if (v.check(isObject(a), "approval is required")) {
      v.keys("approval", a as unknown as Record<string, unknown>, ["moderator", "approvedAt", "signature"]);
      v.check(isNpub(a.moderator), "approval.moderator must be an npub");
      v.check(isTime(a.approvedAt), "approval.approvedAt must be an RFC 3339 UTC time");
      v.check(typeof a.signature === "string" && HEX_SIG.test(a.signature), "approval.signature must be 64-byte hex");
    }
  }
  return v.result();
}

class Validator {
  readonly errors: string[] = [];
  constructor(private readonly limits: Limits) {}

  result(): ValidationResult {
    return this.errors.length ? { ok: false, errors: this.errors } : { ok: true };
  }

  /** Reject any key not in `allowed`: nothing a moderator didn't see may ride along into a signed manifest. */
  keys(at: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
    for (const k of Object.keys(obj))
      if (!allowed.includes(k)) this.errors.push(`${at}${at ? "." : ""}${k} is not allowed`);
  }

  check(cond: boolean, msg: string): boolean {
    if (!cond) this.errors.push(msg);
    return cond;
  }

  /** Returns false if the input isn't even an object (so callers can stop). */
  body(m: Manifest | ApprovalBody, full: boolean): boolean {
    if (!this.check(isObject(m), "manifest must be an object")) return false;
    this.keys("", m as unknown as Record<string, unknown>, full ? TOP_MANIFEST : TOP_BODY);
    const L = this.limits;
    this.check(m.schema === STORY_SCHEMA, `schema must be "${STORY_SCHEMA}"`);
    this.check(isUuidv7(m.id), "id must be a UUIDv7");
    this.check(Number.isInteger(m.version) && m.version >= 1, "version must be an integer ≥ 1");
    if (m.version === 1) this.check(m.supersedes === null, "version 1 must have supersedes = null");
    else
      this.check(isSha256Hex(m.supersedes), "versions after 1 must set supersedes to the previous manifest's sha256");

    const lang = m.language;
    if (!this.check(lang === "en" || lang === "hi" || lang === "both", "language must be en, hi or both")) return true;

    this.text("title", m.title, lang, true, L.maxTitleChars);
    this.text("summary", m.summary, lang, true, L.maxSummaryChars);
    if (m.location !== undefined) this.text("location", m.location, lang, true, 200);

    if (this.check(Array.isArray(m.tags), "tags must be an array")) {
      this.check(m.tags.length <= L.maxTags, `at most ${L.maxTags} tags`);
      m.tags.forEach((t, i) =>
        this.check(typeof t === "string" && t.length > 0 && t.length <= L.maxTagChars, `tags[${i}] is invalid`),
      );
    }

    if (this.check(isObject(m.contributor), "contributor is required")) {
      this.keys("contributor", m.contributor as unknown as Record<string, unknown>, ["pubkey", "displayName"]);
      this.check(isNpub(m.contributor.pubkey), "contributor.pubkey must be an npub");
      this.check(
        typeof m.contributor.displayName === "string" && m.contributor.displayName.length <= 80,
        "contributor.displayName must be a string of at most 80 characters",
      );
    }

    if (m.cover !== undefined && this.check(isObject(m.cover), "cover must be an object")) {
      this.keys("cover", m.cover as unknown as Record<string, unknown>, full ? COVER_KEYS.full : COVER_KEYS.body);
      if (full && m.cover && (m.cover as any).variants !== undefined)
        this.variants("cover.variants", (m.cover as any).variants);
      this.check(isSha256Hex(m.cover.sha256), "cover.sha256 must be a sha256");
      if (full) this.check(isCidV1((m.cover as Manifest["cover"])!.cid), "cover.cid must be a CIDv1");
    }

    if (!this.check(Array.isArray(m.blocks), "blocks must be an array")) return true;
    this.check(m.blocks.length >= 1, "a story needs at least one block");
    this.check(m.blocks.length <= L.maxBlocks, `at most ${L.maxBlocks} blocks`);
    m.blocks.forEach((b, i) => this.block(b as never, `blocks[${i}]`, lang, full));
    return true;
  }

  block(b: Record<string, any>, at: string, lang: StoryLanguage, full: boolean): void {
    if (!this.check(isObject(b), `${at} must be an object`)) return;
    const allowed = BLOCK_KEYS[b.type];
    if (allowed) this.keys(at, b, full ? allowed.full : allowed.body);
    switch (b.type) {
      case "text":
        this.text(`${at}.markdown`, b.markdown, lang, true, 200_000);
        return;
      case "image": {
        const items = b.items;
        if (!this.check(Array.isArray(items), `${at}.items must be an array`)) return;
        this.check(
          items.length >= 1 && items.length <= this.limits.maxImagesPerBlock,
          `${at} needs 1–${this.limits.maxImagesPerBlock} images`,
        );
        items.forEach((it: Record<string, any>, j: number) => {
          const p = `${at}.items[${j}]`;
          if (!this.check(isObject(it), `${p} must be an object`)) return;
          this.keys(p, it, full ? IMAGE_KEYS.full : IMAGE_KEYS.body);
          if (full && it.variants !== undefined) this.variants(`${p}.variants`, it.variants);
          this.check(isSha256Hex(it.sha256), `${p}.sha256 must be a sha256`);
          if (it.caption !== undefined) this.text(`${p}.caption`, it.caption, lang, true, 1000);
          if (full) {
            this.check(isCidV1(it.cid), `${p}.cid must be a CIDv1`);
            this.check(isPosInt(it.width) && isPosInt(it.height), `${p} needs width and height`);
            this.check(typeof it.blurhash === "string" && it.blurhash.length > 0, `${p}.blurhash is required`);
          }
        });
        return;
      }
      case "video":
        this.check(isObject(b.source) && isSha256Hex(b.source.sha256), `${at}.source.sha256 must be a sha256`);
        if (b.title !== undefined) this.text(`${at}.title`, b.title, lang, false, 200);
        if (b.description !== undefined) this.text(`${at}.description`, b.description, lang, false, 5000);
        if (full) {
          this.check(typeof b.hls === "string" && isCidV1(b.hls.split("/")[0]), `${at}.hls must be an IPFS path`);
          this.fileRef(`${at}.mp4`, b.mp4);
          this.fileRef(`${at}.poster`, b.poster);
          if (b.preview !== undefined) this.fileRef(`${at}.preview`, b.preview);
          if (b.magnet !== undefined)
            this.check(typeof b.magnet === "string" && b.magnet.startsWith("magnet:?"), `${at}.magnet is invalid`);
          this.check(typeof b.durationSec === "number" && b.durationSec > 0, `${at}.durationSec is required`);
        }
        return;
      case "embed-story":
        this.check(isUuidv7(b.storyId), `${at}.storyId must be a UUIDv7`);
        if (b.version !== undefined) this.check(isPosInt(b.version), `${at}.version must be an integer ≥ 1`);
        return;
      default:
        this.errors.push(`${at}.type must be text, image, video or embed-story`);
    }
  }

  variants(at: string, v: unknown): void {
    if (!this.check(isObject(v), `${at} must be an object`)) return;
    for (const [k, cid] of Object.entries(v as Record<string, unknown>)) {
      this.check(["480", "960", "1600"].includes(k), `${at}.${k} is not a known width`);
      this.check(isCidV1(cid), `${at}.${k} must be a CIDv1`);
    }
  }

  fileRef(at: string, f: Record<string, any>): void {
    if (!this.check(isObject(f), `${at} is required`)) return;
    this.keys(at, f, ["cid", "sha256"]);
    this.check(isCidV1(f.cid), `${at}.cid must be a CIDv1`);
    this.check(isSha256Hex(f.sha256), `${at}.sha256 must be a sha256`);
  }

  /**
   * Check localized text against the story language. With `strict`, the field must have exactly the languages the
   * story declares; otherwise (video titles) at least one of them.
   */
  text(at: string, t: LocalizedText | undefined, lang: StoryLanguage, strict: boolean, maxChars: number): void {
    if (!this.check(isObject(t), `${at} must be an object with en and/or hi`)) return;
    const need: Array<"en" | "hi"> = lang === "both" ? ["en", "hi"] : [lang];
    for (const k of Object.keys(t!)) this.check(k === "en" || k === "hi", `${at} has an unknown language "${k}"`);
    for (const k of ["en", "hi"] as const) {
      const s = t![k];
      if (s === undefined) continue;
      this.check(typeof s === "string" && s.trim().length > 0, `${at}.${k} must be non-empty text`);
      this.check(
        typeof s !== "string" || [...s].length <= maxChars,
        `${at}.${k} is longer than ${maxChars} characters`,
      );
      if (!need.includes(k)) this.errors.push(`${at}.${k} is not allowed in a "${lang}" story`);
    }
    if (strict) for (const k of need) this.check(t![k] !== undefined, `${at}.${k} is required`);
    else
      this.check(
        need.some((k) => t![k] !== undefined),
        `${at} needs text in ${need.join(" or ")}`,
      );
  }
}

const TOP_BODY = [
  "schema",
  "id",
  "version",
  "supersedes",
  "language",
  "title",
  "summary",
  "cover",
  "tags",
  "location",
  "contributor",
  "blocks",
];
const TOP_MANIFEST = [...TOP_BODY, "approval", "publishedAt", "publisher"];
const BLOCK_KEYS: Record<string, { body: string[]; full: string[] }> = {
  text: { body: ["type", "markdown"], full: ["type", "markdown"] },
  image: { body: ["type", "items"], full: ["type", "items"] },
  video: {
    body: ["type", "source", "title", "description"],
    full: ["type", "source", "title", "description", "hls", "mp4", "poster", "preview", "magnet", "durationSec"],
  },
  "embed-story": { body: ["type", "storyId", "version"], full: ["type", "storyId", "version"] },
};
const IMAGE_KEYS = {
  body: ["sha256", "caption"],
  full: ["sha256", "caption", "cid", "width", "height", "blurhash", "variants"],
};
const COVER_KEYS = { body: ["sha256"], full: ["sha256", "cid", "variants", "width", "height", "blurhash"] };

function isObject(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isPosInt(x: unknown): boolean {
  return Number.isInteger(x) && (x as number) > 0;
}
function isTime(x: unknown): boolean {
  return typeof x === "string" && RFC3339_UTC.test(x) && !Number.isNaN(Date.parse(x));
}
