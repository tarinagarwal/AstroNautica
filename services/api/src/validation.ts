/** Request validation (zod). Every body and parameter is checked strictly; unknown fields are rejected. */
import { isUuidv7 } from "@azaadawaaz/schema";
import { z } from "zod";
import { badRequest } from "./errors.js";

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");
export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be a lowercase UUID");
export const uuidv7 = z.string().refine((s) => isUuidv7(s), "must be a lowercase UUIDv7");

/** A libsodium sealed box of a 32-byte key: 32 + 48 = 80 bytes = 107 base64url characters (no padding). */
export const wrappedKey = z.string().regex(/^[A-Za-z0-9_-]{107}$/, "must be a sealed 32-byte key (base64url)");

/** `core.encryptJson` output: base64url(24-byte header) "." base64url(ciphertext). */
export const sealedJson = (maxChars: number) =>
  z
    .string()
    .max(maxChars, "is too large")
    .regex(/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{23,}$/, "must be core.encryptJson output");

/** NIP-44 v2 payload (standard base64). */
export const nip44 = z
  .string()
  .min(132, "is not a NIP-44 payload")
  .max(100_000, "is too large")
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "is not a NIP-44 payload");

export const MAX_RECIPIENTS = 64;
export const wrappedKeys = z
  .record(hex64, wrappedKey)
  .refine((o) => Object.keys(o).length >= 1, "must not be empty")
  .refine((o) => Object.keys(o).length <= MAX_RECIPIENTS, `must have at most ${MAX_RECIPIENTS} recipients`);

export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const VIDEO_MIMES = ["video/mp4", "video/quicktime"] as const;

export const mediaItem = z
  .object({
    sha256: hex64,
    size: z.number().int().min(1),
    mime: z.string(),
    kind: z.enum(["image", "video"]),
    chunks: z.number().int().min(1),
  })
  .strict()
  .refine(
    (m) => (m.kind === "image" ? IMAGE_MIMES : VIDEO_MIMES).includes(m.mime as never),
    "mime is not allowed for this kind of media",
  );

export const event = z.record(z.string(), z.unknown());

export const submissionBody = (maxBodyChars: number, maxMedia: number) =>
  z
    .object({
      storyId: uuidv7,
      version: z.number().int().min(1).max(1_000_000),
      supersedes: hex64.nullable(),
      bodyCiphertext: sealedJson(maxBodyChars),
      wrappedKeys,
      media: z.array(mediaItem).max(maxMedia),
    })
    .strict()
    .refine((b) => (b.version === 1) === (b.supersedes === null), "supersedes must be null exactly for version 1");

export const redeemBody = z.object({ redemption: event }).strict();
export const inviteRevokeBody = z.object({ inviteId: hex64 }).strict();
export const auditBody = z.object({ auditEvent: event }).strict();
export const claimBody = z.object({ auditEvent: event.optional() }).strict().optional();
export const feedbackBody = z.object({ feedback: nip44, auditEvent: event }).strict();
export const keysBody = z.object({ wrappedKeys }).strict();
export const unlistBody = z.object({ storyId: uuidv7, auditEvent: event }).strict();
export const alertsSeenBody = z
  .object({ ids: z.array(z.number().int().min(1)).max(1000).optional() })
  .strict()
  .optional();

export const approval = z
  .object({
    moderator: z.string().regex(/^npub1[02-9ac-hj-np-z]{58}$/, "must be an npub"),
    approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/, "must be RFC 3339 UTC"),
    signature: z.string().regex(/^[0-9a-f]{128}$/, "must be a 64-byte hex signature"),
  })
  .strict();

export const approveBody = z
  .object({
    approval,
    approvalBodySha256: hex64,
    publisherWrappedKey: wrappedKey,
    auditEvent: event,
  })
  .strict();

/** Parse `data` with `schema` or throw 400 with every problem listed. */
export function parse<T extends z.ZodType>(schema: T, data: unknown, what = "body"): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const msg = r.error.issues
    .slice(0, 10)
    .map((i) => `${i.path.length ? i.path.join(".") : what}: ${i.message}`)
    .join("; ");
  throw badRequest(`invalid_${what}`, msg);
}
