/**
 * The moderation state machine (spec §5.1). Every state change of a submission goes through `transition()`, which
 * applies the change with a single guarded `UPDATE … WHERE state = ANY(<allowed from-states>)`. Concurrent requests
 * are therefore serialised by the row lock: e.g. of two simultaneous approvals exactly one matches the guard, the
 * other sees the new state and fails with 409 (first approval wins).
 *
 *   draft ──submit──► submitted ──claim──► in_review ──approve──► approved ──► publishing ──► published ──unlist──► unlisted
 *                         ▲                    │  └──reject──► rejected (final)
 *                         └──resubmit── changes_requested ◄──request changes
 */
import type { Queryable } from "./db.js";
import { HttpError, notFound } from "./errors.js";

export const STATES = [
  "draft",
  "submitted",
  "in_review",
  "changes_requested",
  "rejected",
  "approved",
  "publishing",
  "published",
  "unlisted",
] as const;
export type State = (typeof STATES)[number];

export interface Transition {
  from: readonly State[];
  /** The new state, or null when the action is only allowed in `from` and leaves the state unchanged. */
  to: State | null;
}

export const TRANSITIONS = {
  /** Contributor edits the encrypted body, wrapped keys or media list. */
  edit: { from: ["draft", "changes_requested"], to: null },
  /** Contributor uploads or completes media. */
  upload: { from: ["draft", "changes_requested"], to: null },
  /** Submit (from draft) or resubmit (after a change request). */
  submit: { from: ["draft", "changes_requested"], to: "submitted" },
  /** Advisory claim; re-claiming refreshes it or takes over an expired one. */
  claim: { from: ["submitted", "in_review"], to: "in_review" },
  approve: { from: ["in_review"], to: "approved" },
  /** Final. */
  reject: { from: ["in_review"], to: "rejected" },
  request_changes: { from: ["in_review"], to: "changes_requested" },
  /** Moderators add content-key wraps for new moderators while a submission is still under moderation. */
  rewrap: { from: ["draft", "submitted", "in_review", "changes_requested"], to: null },
  /** Publisher (services/publisher) claims the job; a retry keeps it in publishing. */
  start_publishing: { from: ["approved", "publishing"], to: "publishing" },
  /** Publisher: manifest on IPFS and the required relays. */
  mark_published: { from: ["publishing"], to: "published" },
  unlist: { from: ["published"], to: "unlisted" },
} as const satisfies Record<string, Transition>;

export type Action = keyof typeof TRANSITIONS;

export function canTransition(action: Action, from: State): boolean {
  return (TRANSITIONS[action].from as readonly State[]).includes(from);
}

export function nextState(action: Action, from: State): State {
  if (!canTransition(action, from)) throw new TransitionError(action, from);
  return TRANSITIONS[action].to ?? from;
}

export class TransitionError extends HttpError {
  constructor(
    readonly action: Action,
    readonly from: State,
  ) {
    super(409, "invalid_state", `cannot ${action.replace("_", " ")} a submission in state ${from}`);
  }
}

/** Columns a transition may set alongside the state (internal names only; never taken from requests). */
const SETTABLE = new Set([
  "body_ciphertext",
  "wrapped_keys",
  "media",
  "claim_by",
  "claim_until",
  "approval",
  "approval_body_sha256",
  "publisher_wrapped_key",
  "feedback",
  "story_id",
  "version",
  "supersedes",
  "submitted_at",
  "decided_at",
  "published_at",
  "manifest_sha256",
  "manifest_cid",
]);

/** A value written as a SQL expression instead of a parameter (only for the fixed expressions below). */
export class Sql {
  constructor(readonly text: string) {}
}
export const NOW = new Sql("now()");
/** Append a JSON value to the jsonb array column `feedback`. */
export const appendFeedback = (entry: unknown) => ({ kind: "append-feedback" as const, entry });

export interface TransitionOptions {
  /** The submission id. */
  id: string;
  /** Restrict to submissions owned by this contributor. */
  contributor?: string;
  sets?: Record<string, unknown>;
}

export interface SubmissionRow {
  id: string;
  story_id: string;
  version: number;
  supersedes: string | null;
  contributor: string;
  state: State;
  body_ciphertext: string;
  wrapped_keys: Record<string, string>;
  media: MediaItem[];
  claim_by: string | null;
  claim_until: Date | null;
  approval: unknown;
  approval_body_sha256: string | null;
  publisher_wrapped_key: string | null;
  feedback: FeedbackEntry[] | null;
  manifest_sha256: string | null;
  manifest_cid: string | null;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  decided_at: Date | null;
  published_at: Date | null;
  staging_purged_at: Date | null;
}

export interface MediaItem {
  sha256: string;
  size: number;
  mime: string;
  kind: "image" | "video";
  chunks: number;
  header?: boolean;
  complete: boolean;
}

export interface FeedbackEntry {
  at: string;
  moderator: string;
  kind: "reject" | "changes";
  nip44: string;
}

/**
 * Apply `action` to one submission atomically. Returns the updated row. Throws 404 if the submission does not exist
 * (or is not the contributor's), and `TransitionError` (409) if its current state does not allow the action.
 */
export async function transition(db: Queryable, action: Action, opts: TransitionOptions): Promise<SubmissionRow> {
  const t: Transition = TRANSITIONS[action];
  const params: unknown[] = [opts.id, t.from];
  const assignments = [
    t.to ? `state = $${params.push(t.to)}::submission_state` : "state = state",
    "updated_at = now()",
  ];
  for (const [col, value] of Object.entries(opts.sets ?? {})) {
    if (!SETTABLE.has(col)) throw new Error(`transition cannot set column ${col}`);
    if (value instanceof Sql) assignments.push(`${col} = ${value.text}`);
    else if (col === "feedback" && isAppend(value))
      assignments.push(
        `feedback = coalesce(feedback, '[]'::jsonb) || jsonb_build_array($${params.push(JSON.stringify(value.entry))}::jsonb)`,
      );
    else if (col === "wrapped_keys" || col === "media" || col === "approval")
      assignments.push(`${col} = $${params.push(value === null ? null : JSON.stringify(value))}::jsonb`);
    else assignments.push(`${col} = $${params.push(value)}`);
  }
  let where = "id = $1 AND state = ANY($2::submission_state[])";
  if (opts.contributor !== undefined) where += ` AND contributor = $${params.push(opts.contributor)}`;
  const r = await db.query<SubmissionRow>(
    `UPDATE submissions SET ${assignments.join(", ")} WHERE ${where} RETURNING *`,
    params,
  );
  if (r.rows[0]) return r.rows[0];
  const cur = await db.query<{ state: State; contributor: string }>(
    "SELECT state, contributor FROM submissions WHERE id = $1",
    [opts.id],
  );
  const row = cur.rows[0];
  if (!row || (opts.contributor !== undefined && row.contributor !== opts.contributor)) throw notFound("submission");
  throw new TransitionError(action, row.state);
}

function isAppend(v: unknown): v is { kind: "append-feedback"; entry: unknown } {
  return typeof v === "object" && v !== null && (v as { kind?: string }).kind === "append-feedback";
}

/** Record a history entry for a submission (table `submission_events`). */
export async function recordEvent(
  db: Queryable,
  e: { submissionId: string; actor: string; event: string; from?: State | null; to?: State | null; detail?: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO submission_events (submission_id, actor, event, from_state, to_state, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [e.submissionId, e.actor, e.event, e.from ?? null, e.to ?? null, JSON.stringify(e.detail ?? {})],
  );
}
