/**
 * Retention job (spec §5.2, docs/architecture.md "Staging blob store"): deletes the staging data of rejected
 * submissions after REJECTED_RETENTION_DAYS, of published (or since unlisted) submissions, and of abandoned
 * `draft` / `changes_requested` submissions not updated for DRAFT_RETENTION_DAYS (which then expire: 410 on any
 * further write), and prunes old rate-limit events and expired NIP-98 replay entries. Runs on an interval in `main.ts`, or once with `pnpm --filter @azaadawaaz/api cleanup`.
 */
import { pathToFileURL } from "node:url";
import { createPool, type Pool } from "./db.js";
import { StagingStore } from "./staging.js";

export interface CleanupResult {
  rejectedPurged: number;
  publishedPurged: number;
  draftsExpired: number;
  rateEventsPruned: number;
  authReplayPruned: number;
}

export const DEFAULT_DRAFT_RETENTION_DAYS = 30;

export async function runCleanup(opts: {
  pool: Pool;
  staging: StagingStore;
  rejectedRetentionDays: number;
  draftRetentionDays?: number;
}): Promise<CleanupResult> {
  const { pool, staging } = opts;
  const rejected = await pool.query<{ id: string }>(
    `SELECT id FROM submissions WHERE state = 'rejected' AND staging_purged_at IS NULL
     AND decided_at < now() - make_interval(days => $1)`,
    [opts.rejectedRetentionDays],
  );
  const published = await pool.query<{ id: string }>(
    "SELECT id FROM submissions WHERE state IN ('published', 'unlisted') AND staging_purged_at IS NULL",
  );
  const draftDays = opts.draftRetentionDays ?? DEFAULT_DRAFT_RETENTION_DAYS;
  const abandoned = await pool.query<{ id: string }>(
    `SELECT id FROM submissions WHERE state IN ('draft', 'changes_requested') AND staging_purged_at IS NULL
     AND updated_at < now() - make_interval(days => $1)`,
    [draftDays],
  );
  const purge = async (id: string, states: string[], staleDays?: number): Promise<boolean> => {
    // Final states: remove the files first, so a failure leaves the row unmarked and the next run retries.
    // Drafts: mark the row first (guarded on still being stale, so a draft edited meanwhile keeps its data); uploads
    // check staging_purged_at under the row lock, so none can land after the directory is removed.
    if (staleDays === undefined) await staging.removeSubmission(id);
    const r = await pool.query(
      `UPDATE submissions SET staging_purged_at = now(), body_ciphertext = '', wrapped_keys = '{}'::jsonb,
         publisher_wrapped_key = NULL, updated_at = now()
       WHERE id = $1 AND staging_purged_at IS NULL AND state = ANY($2::submission_state[])
         AND ($3::int IS NULL OR updated_at < now() - make_interval(days => $3::int))`,
      [id, states, staleDays ?? null],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    if (staleDays !== undefined) await staging.removeSubmission(id);
    // History snapshots hold earlier encrypted bodies: remove those too.
    await pool.query("UPDATE submission_events SET detail = detail - 'previous' WHERE submission_id = $1", [id]);
    return true;
  };
  let rejectedPurged = 0;
  for (const { id } of rejected.rows) if (await purge(id, ["rejected"])) rejectedPurged++;
  let publishedPurged = 0;
  for (const { id } of published.rows) if (await purge(id, ["published", "unlisted"])) publishedPurged++;
  let draftsExpired = 0;
  for (const { id } of abandoned.rows) if (await purge(id, ["draft", "changes_requested"], draftDays)) draftsExpired++;
  const pruned = await pool.query("DELETE FROM rate_events WHERE at < now() - interval '1 day'");
  const replay = await pool.query("DELETE FROM auth_replay WHERE expires_at < now()");
  return {
    rejectedPurged,
    publishedPurged,
    draftsExpired,
    rateEventsPruned: pruned.rowCount ?? 0,
    authReplayPruned: replay.rowCount ?? 0,
  };
}

async function main() {
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 2);
  try {
    const r = await runCleanup({
      pool,
      staging: new StagingStore(config.stagingDir),
      rejectedRetentionDays: config.rejectedRetentionDays,
      draftRetentionDays: config.draftRetentionDays,
    });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
