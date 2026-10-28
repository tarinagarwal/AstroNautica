/**
 * Retention job (spec §5.2, docs/architecture.md "Staging blob store"): deletes the staging data of rejected
 * submissions after REJECTED_RETENTION_DAYS and of published (or since unlisted) submissions, and prunes old
 * rate-limit events. Runs on an interval in `main.ts`, or once with `pnpm --filter @azaadawaaz/api cleanup`.
 */
import { pathToFileURL } from "node:url";
import { createPool, type Pool } from "./db.js";
import { StagingStore } from "./staging.js";

export interface CleanupResult {
  rejectedPurged: number;
  publishedPurged: number;
  rateEventsPruned: number;
}

export async function runCleanup(opts: {
  pool: Pool;
  staging: StagingStore;
  rejectedRetentionDays: number;
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
  const purge = async (id: string, states: string[]): Promise<boolean> => {
    await staging.removeSubmission(id);
    const r = await pool.query(
      `UPDATE submissions SET staging_purged_at = now(), body_ciphertext = '', wrapped_keys = '{}'::jsonb,
         publisher_wrapped_key = NULL, updated_at = now()
       WHERE id = $1 AND staging_purged_at IS NULL AND state = ANY($2::submission_state[])`,
      [id, states],
    );
    // History snapshots hold earlier encrypted bodies: remove those too.
    await pool.query("UPDATE submission_events SET detail = detail - 'previous' WHERE submission_id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  };
  let rejectedPurged = 0;
  for (const { id } of rejected.rows) if (await purge(id, ["rejected"])) rejectedPurged++;
  let publishedPurged = 0;
  for (const { id } of published.rows) if (await purge(id, ["published", "unlisted"])) publishedPurged++;
  const pruned = await pool.query("DELETE FROM rate_events WHERE at < now() - interval '1 day'");
  return { rejectedPurged, publishedPurged, rateEventsPruned: pruned.rowCount ?? 0 };
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
