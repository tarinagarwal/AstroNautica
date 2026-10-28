import { sha256Hex } from "@azaadawaaz/schema";
import { finalizeEvent, type Event } from "nostr-tools/pure";
import { toPubkeyHex, verifyEventStrict } from "./keys.js";
import { KIND_AUDIT } from "./kinds.js";

/** NIP-98 HTTP auth event kind. */
export const KIND_HTTP_AUTH = 27235;
/** An owner-signed invite (never published to relays; carried in a link or QR code). */
export const KIND_INVITE = 9739;
/** A contributor's signed redemption of an invite. */
export const KIND_REDEMPTION = 9740;

const enc = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const dec = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** Build an `Authorization: Nostr <base64>` header value (NIP-98). */
export function createAuthHeader(
  url: string,
  method: string,
  secretKey: Uint8Array,
  body?: Uint8Array | string,
  createdAt = Math.floor(Date.now() / 1000),
): string {
  // A random nonce keeps two identical requests in the same second from sharing an event id (the API rejects replays).
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
    ["nonce", randomCode()],
  ];
  if (body !== undefined && (typeof body === "string" ? body.length : body.length) > 0) {
    tags.push(["payload", sha256Hex(body)]);
  }
  const e = finalizeEvent({ kind: KIND_HTTP_AUTH, created_at: createdAt, tags, content: "" }, secretKey);
  return `Nostr ${btoa(JSON.stringify(e))}`;
}

export type AuthResult = { ok: true; pubkey: string; eventId: string } | { ok: false; error: string };

/**
 * Verify a NIP-98 header against the request. The caller must also reject replays of `eventId` within the window
 * (the API keeps a short-lived set of seen ids).
 */
export function verifyAuthHeader(
  header: string | undefined,
  url: string,
  method: string,
  body?: Uint8Array | string,
  now = Math.floor(Date.now() / 1000),
  windowSec = 60,
): AuthResult {
  if (!header?.startsWith("Nostr ")) return { ok: false, error: "missing Nostr authorization" };
  let e: Event;
  try {
    e = JSON.parse(atob(header.slice(6).trim()));
  } catch {
    return { ok: false, error: "malformed authorization" };
  }
  if (e.kind !== KIND_HTTP_AUTH) return { ok: false, error: "wrong event kind" };
  if (Math.abs(now - e.created_at) > windowSec) return { ok: false, error: "authorization expired" };
  const tag = (n: string) => e.tags.find((t) => t[0] === n)?.[1];
  if (tag("u") !== url) return { ok: false, error: "url mismatch" };
  if (tag("method") !== method.toUpperCase()) return { ok: false, error: "method mismatch" };
  const hasBody = body !== undefined && (typeof body === "string" ? body.length : body.length) > 0;
  if (hasBody && tag("payload") !== sha256Hex(body!)) return { ok: false, error: "payload mismatch" };
  if (!verifyEventStrict(e)) return { ok: false, error: "bad signature" };
  return { ok: true, pubkey: e.pubkey, eventId: e.id };
}

// ---- Invites (spec §3.1) ----

export interface InviteContent {
  schema: "azaadawaaz/invite@1";
  code: string;
  expiresAt?: number;
  note?: string;
}

export function createInvite(
  ownerSecretKey: Uint8Array,
  opts: { code?: string; expiresAt?: number; note?: string } = {},
  createdAt = Math.floor(Date.now() / 1000),
): { event: Event; link: string; code: string } {
  const code = opts.code ?? randomCode();
  const content: InviteContent = { schema: "azaadawaaz/invite@1", code };
  if (opts.expiresAt !== undefined) content.expiresAt = opts.expiresAt;
  if (opts.note) content.note = opts.note;
  const event = finalizeEvent(
    { kind: KIND_INVITE, created_at: createdAt, tags: [], content: JSON.stringify(content) },
    ownerSecretKey,
  );
  return { event, code, link: encodeInvite(event) };
}

/** Encode an invite for the `#invite=` fragment of a link (the fragment never reaches a server's logs). */
export function encodeInvite(e: Event): string {
  return enc(JSON.stringify(e));
}

export function decodeInvite(s: string): Event {
  return JSON.parse(dec(s));
}

export type InviteCheck = { ok: true; content: InviteContent } | { ok: false; error: string };

export function verifyInvite(e: Event, ownerKey: string, now = Math.floor(Date.now() / 1000)): InviteCheck {
  if (e?.kind !== KIND_INVITE) return { ok: false, error: "not an invite" };
  if (e.pubkey !== toPubkeyHex(ownerKey)) return { ok: false, error: "invite is not signed by the owner" };
  if (!verifyEventStrict(e)) return { ok: false, error: "bad invite signature" };
  let c: InviteContent;
  try {
    c = JSON.parse(e.content);
  } catch {
    return { ok: false, error: "malformed invite" };
  }
  if (c.schema !== "azaadawaaz/invite@1" || typeof c.code !== "string" || c.code.length < 16)
    return { ok: false, error: "malformed invite" };
  if (c.expiresAt !== undefined && now > c.expiresAt) return { ok: false, error: "invite expired" };
  return { ok: true, content: c };
}

/** The contributor's signed redemption: proves the new key accepted this invite. */
export function createRedemption(
  invite: Event,
  contributorSecretKey: Uint8Array,
  createdAt = Math.floor(Date.now() / 1000),
): Event {
  return finalizeEvent(
    { kind: KIND_REDEMPTION, created_at: createdAt, tags: [["e", invite.id]], content: JSON.stringify(invite) },
    contributorSecretKey,
  );
}

export type RedemptionCheck =
  { ok: true; contributor: string; invite: Event; content: InviteContent } | { ok: false; error: string };

export function verifyRedemption(r: Event, ownerKey: string, now = Math.floor(Date.now() / 1000)): RedemptionCheck {
  if (r?.kind !== KIND_REDEMPTION || !verifyEventStrict(r)) return { ok: false, error: "bad redemption" };
  let invite: Event;
  try {
    invite = JSON.parse(r.content);
  } catch {
    return { ok: false, error: "malformed redemption" };
  }
  if (r.tags.find((t) => t[0] === "e")?.[1] !== invite.id)
    return { ok: false, error: "redemption does not match invite" };
  const c = verifyInvite(invite, ownerKey, now);
  if (!c.ok) return c;
  return { ok: true, contributor: r.pubkey, invite, content: c.content };
}

function randomCode(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- Moderation audit events (docs/architecture.md) ----

export type AuditAction =
  | "approve"
  | "reject"
  | "request_changes"
  | "unlist"
  | "hide"
  | "mute"
  | "claim"
  | "revoke_contributor";

/**
 * A moderator-signed audit event (kind 9737). `s` is sha256(submission id) so rejected submissions stay unidentifiable;
 * `story` is added for approve and unlist; `e`/`p` name the hidden comment or muted/revoked key.
 */
export function createAuditEvent(
  args: { action: AuditAction; submissionId?: string; storyId?: string; eventId?: string; pubkey?: string },
  secretKey: Uint8Array,
  createdAt = Math.floor(Date.now() / 1000),
): Event {
  const tags: string[][] = [["action", args.action]];
  if (args.submissionId) tags.push(["s", sha256Hex(args.submissionId)]);
  if (args.storyId && (args.action === "approve" || args.action === "unlist")) tags.push(["story", args.storyId]);
  if (args.eventId) tags.push(["e", args.eventId]);
  if (args.pubkey) tags.push(["p", args.pubkey]);
  tags.push(["nonce", randomCode()]);
  return finalizeEvent({ kind: KIND_AUDIT, created_at: createdAt, tags, content: "" }, secretKey);
}
