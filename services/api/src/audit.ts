/**
 * Audit events (spec §5.3, docs/architecture.md): kind 9737, signed by the acting moderator, content empty, tags
 * `["action", <action>]` plus the target. They are stored in `audit_events` and forwarded to our own relays.
 */
import { KIND_AUDIT, verifyEventStrict, type Event } from "@azaadawaaz/core";
import { sha256Hex } from "@azaadawaaz/schema";
import { isUniqueViolation, type Queryable } from "./db.js";
import { badRequest, conflict } from "./errors.js";

export const AUDIT_ACTIONS = [
  "approve",
  "reject",
  "request_changes",
  "unlist",
  "hide",
  "mute",
  "claim",
  "revoke_contributor",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** How far an audit event's `created_at` may be from the server clock. */
export const AUDIT_WINDOW_SEC = 600;

export interface AuditExpectation {
  actor: string;
  action: AuditAction;
  /** Required `["s", sha256(submission id)]` (never the plain id). */
  submissionId?: string;
  /** Required `["story", <story id>]` (approve, unlist). */
  storyId?: string;
  /** Required target tag, e.g. `["p", <pubkey>]` for revoke/mute or `["e", <event id>]` for hide. */
  target?: { tag: "p" | "e"; value?: string };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Validate an audit event against what the request is doing. Throws 400 with a precise reason. */
export function verifyAuditEvent(raw: unknown, x: AuditExpectation, nowSec = Math.floor(Date.now() / 1000)): Event {
  const e = raw as Event;
  if (typeof e !== "object" || e === null || Array.isArray(e))
    throw badRequest("invalid_audit", "auditEvent is required");
  if (!verifyEventStrict(e)) throw badRequest("invalid_audit", "audit event signature or id is invalid");
  if (e.kind !== KIND_AUDIT) throw badRequest("invalid_audit", `audit event must be kind ${KIND_AUDIT}`);
  if (e.pubkey !== x.actor) throw badRequest("invalid_audit", "audit event must be signed by the caller");
  if (e.content !== "") throw badRequest("invalid_audit", "audit event content must be empty");
  if (Math.abs(nowSec - e.created_at) > AUDIT_WINDOW_SEC)
    throw badRequest("invalid_audit", "audit event created_at is too far from the server time");
  const values = (name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const one = (name: string): string | undefined => {
    const v = values(name);
    if (v.length > 1) throw badRequest("invalid_audit", `audit event has more than one "${name}" tag`);
    return v[0];
  };
  if (one("action") !== x.action) throw badRequest("invalid_audit", `audit event action must be "${x.action}"`);
  if (values("d").length) throw badRequest("invalid_audit", "audit event must not carry a d tag");
  if (x.submissionId !== undefined) {
    if (one("s") !== sha256Hex(x.submissionId.toLowerCase()))
      throw badRequest("invalid_audit", "audit event s tag must be sha256(submission id)");
  }
  if (x.storyId !== undefined && one("story") !== x.storyId.toLowerCase())
    throw badRequest("invalid_audit", "audit event story tag must be the story id");
  if (x.action === "reject" || x.action === "request_changes") {
    if (values("story").length)
      throw badRequest("invalid_audit", "rejections and change requests must not reveal the story id");
  }
  if (x.target) {
    const v = one(x.target.tag);
    if (!v || !HEX64.test(v)) throw badRequest("invalid_audit", `audit event needs a "${x.target.tag}" tag`);
    if (x.target.value !== undefined && v !== x.target.value)
      throw badRequest("invalid_audit", `audit event "${x.target.tag}" tag does not match the request`);
  }
  return e;
}

export function auditTarget(e: Event, tag: "p" | "e"): string {
  return e.tags.find((t) => t[0] === tag)![1]!;
}

/** Store an audit event (inside the caller's transaction). A duplicate event id is a 409. */
export async function storeAudit(
  db: Queryable,
  e: Event,
  meta: { action: AuditAction; submissionId?: string | null },
): Promise<void> {
  try {
    await db.query(
      "INSERT INTO audit_events (id, submission_id, actor, action, event) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [e.id, meta.submissionId ?? null, e.pubkey, meta.action, JSON.stringify(e)],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("audit_replayed", "this audit event was already used");
    throw err;
  }
}

/** Sends stored audit events to our own relays. */
export interface AuditForwarder {
  forward(event: Event): void;
}
