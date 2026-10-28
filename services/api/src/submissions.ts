/** Shared submission logic: loading, access control, validation of media and wrapped keys, and the JSON views. */
import type { FastifyRequest } from "fastify";
import { getContributor } from "./auth.js";
import { caller, type Ctx } from "./context.js";
import type { Queryable } from "./db.js";
import { HttpError, badRequest, forbidden, notFound } from "./errors.js";
import type { MediaItem, SubmissionRow } from "./stateMachine.js";
import { chunkCount, isUuid } from "./staging.js";
import { hex64, parse } from "./validation.js";

export function parseId(id: string): string {
  if (!isUuid(id)) throw notFound("submission");
  return id;
}

export async function loadSubmission(db: Queryable, id: string, forUpdate = false): Promise<SubmissionRow> {
  const r = await db.query<SubmissionRow>(`SELECT * FROM submissions WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [
    id,
  ]);
  if (!r.rows[0]) throw notFound("submission");
  return r.rows[0];
}

export type Access = "staff" | "own";

/**
 * Read access: moderators and the owner see every submission; a contributor (revoked or not) only their own.
 * Anyone else gets 404 for submissions that aren't theirs, so ids can't be probed.
 */
export async function readAccess(ctx: Ctx, req: FastifyRequest, row: SubmissionRow): Promise<Access> {
  const pk = caller(req);
  if (ctx.lists.isModerator(pk)) return "staff";
  if (row.contributor === pk && (await getContributor(ctx.pool, pk))) return "own";
  throw notFound("submission");
}

/** Validate a media list against the configured limits. */
export function validateMedia(ctx: Ctx, media: Omit<MediaItem, "complete">[]): void {
  const seen = new Set<string>();
  for (const m of media) {
    if (seen.has(m.sha256)) throw badRequest("invalid_media", `media ${m.sha256} is listed twice`);
    seen.add(m.sha256);
    const max = m.kind === "image" ? ctx.config.maxImageBytes : ctx.config.maxVideoBytes;
    if (m.size > max) throw badRequest("media_too_large", `${m.kind} ${m.sha256} is larger than ${max} bytes`);
    if (m.chunks !== chunkCount(m.size))
      throw badRequest("invalid_media", `media ${m.sha256}: chunks must be ${chunkCount(m.size)} for ${m.size} bytes`);
  }
}

/**
 * The content key must be wrapped for the owner and every active moderator (spec §5.2), and never for a publisher
 * key: the publisher gets its wrap only with an approval (decision D2). Extra recipients (e.g. the contributor's own
 * device key) are allowed.
 */
export function checkWrappedKeys(ctx: Ctx, wrapped: Record<string, string>): void {
  if (!ctx.lists.ready() || !ctx.lists.ownerX25519())
    throw new HttpError(503, "lists_unavailable", "the signed moderator and service-key lists are not loaded yet");
  const missing = ctx.lists.requiredRecipients().filter((k) => !(k in wrapped));
  if (missing.length)
    throw badRequest("missing_wrapped_keys", `content key is not wrapped for: ${missing.join(", ")}`);
  const publisherKeys = ctx.lists.publisherX25519Keys();
  if (Object.keys(wrapped).some((k) => publisherKeys.has(k)))
    throw badRequest("publisher_wrap_forbidden", "the publisher may only receive the content key with an approval");
}

/** Which wrapped key the caller may receive for `?x25519=`. */
export function wrappedKeyFor(
  ctx: Ctx,
  req: FastifyRequest,
  access: Access,
  wrapped: Record<string, string>,
  x25519Param: unknown,
): string | null {
  if (x25519Param === undefined) return null;
  const x = parse(hex64, x25519Param, "x25519");
  const pk = caller(req);
  if (access === "staff") {
    if (ctx.lists.x25519For(pk) !== x) throw forbidden("x25519 is not your listed encryption key");
    return wrapped[x] ?? null;
  }
  // A contributor may fetch a wrap for an extra key of their own, never one of the staff or publisher keys.
  if (ctx.lists.requiredRecipients().includes(x) || ctx.lists.publisherX25519Keys().has(x))
    throw forbidden("x25519 belongs to someone else");
  return wrapped[x] ?? null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function mediaView(m: MediaItem) {
  return { sha256: m.sha256, size: m.size, mime: m.mime, kind: m.kind, chunks: m.chunks, complete: m.complete };
}

/** A claim counts only while unexpired and held by a current moderator (removed moderators' claims are released). */
export function activeClaim(ctx: Ctx, row: Pick<SubmissionRow, "claim_by" | "claim_until">) {
  if (!row.claim_by || !row.claim_until || row.claim_until.getTime() <= ctx.now()) return null;
  if (!ctx.lists.isModerator(row.claim_by)) return null;
  return { by: row.claim_by, until: row.claim_until.toISOString() };
}

export function submissionView(ctx: Ctx, row: SubmissionRow) {
  const claim = activeClaim(ctx, row);
  return {
    id: row.id,
    storyId: row.story_id,
    version: row.version,
    supersedes: row.supersedes,
    contributor: row.contributor,
    state: row.state,
    bodyCiphertext: row.body_ciphertext,
    media: row.media.map(mediaView),
    claimBy: claim?.by ?? null,
    claimUntil: claim?.until ?? null,
    approval: row.approval ?? null,
    approvalBodySha256: row.approval_body_sha256,
    feedback: row.feedback ?? [],
    manifestSha256: row.manifest_sha256,
    manifestCid: row.manifest_cid,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    submittedAt: iso(row.submitted_at),
    decidedAt: iso(row.decided_at),
    publishedAt: iso(row.published_at),
    stagingPurgedAt: iso(row.staging_purged_at),
  };
}
