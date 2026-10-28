import pg from "pg";

export interface StepRecord {
  done: boolean;
  result?: any;
  error?: string;
  attempts: number;
  at: string;
}

export type Steps = Record<string, StepRecord>;

export interface SubmissionRow {
  id: string;
  story_id: string;
  version: number;
  supersedes: string | null;
  contributor: string;
  state: string;
  body_ciphertext: string;
  media: { sha256: string; size: number; mime: string; kind: "image" | "video"; chunks: number; complete?: boolean }[];
  approval: any;
  approval_body_sha256: string;
  publisher_wrapped_key: string;
  manifest_sha256: string | null;
  manifest_cid: string | null;
}

export interface Job {
  submission_id: string;
  state: string;
  steps: Steps;
  attempts: number;
}

export class PublisherDb {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  }

  /** Claim one due job, locking it for `lockSeconds`. Returns null when there is nothing to do. */
  async claimJob(workerId: string, lockSeconds = 600): Promise<Job | null> {
    const { rows } = await this.pool.query<Job>(
      `UPDATE publish_jobs SET state = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $2),
              updated_at = now()
        WHERE submission_id = (
          SELECT submission_id FROM publish_jobs
           WHERE state IN ('pending', 'failed', 'running') AND next_attempt_at <= now()
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING submission_id, state, steps, attempts`,
      [workerId, lockSeconds],
    );
    return rows[0] ?? null;
  }

  async extendLock(id: string, workerId: string, lockSeconds = 600): Promise<void> {
    await this.pool.query(
      `UPDATE publish_jobs SET locked_until = now() + make_interval(secs => $3) WHERE submission_id = $1 AND locked_by = $2`,
      [id, workerId, lockSeconds],
    );
  }

  async getSubmission(id: string): Promise<SubmissionRow> {
    const { rows } = await this.pool.query<SubmissionRow>(`SELECT * FROM submissions WHERE id = $1`, [id]);
    if (!rows[0]) throw new Error(`submission ${id} not found`);
    return rows[0];
  }

  async isContributorRevoked(pubkey: string): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT revoked_at FROM contributors WHERE pubkey = $1`, [pubkey]);
    return !rows[0] || rows[0].revoked_at !== null;
  }

  async saveStep(id: string, name: string, rec: StepRecord): Promise<void> {
    await this.pool.query(
      `UPDATE publish_jobs SET steps = jsonb_set(steps, $2, $3::jsonb, true), updated_at = now() WHERE submission_id = $1`,
      [id, `{${name}}`, JSON.stringify(rec)],
    );
  }

  async setSubmissionState(id: string, state: string, fields: Record<string, unknown> = {}): Promise<void> {
    const sets = ["state = $2", "updated_at = now()"];
    const vals: unknown[] = [id, state];
    for (const [k, v] of Object.entries(fields)) {
      if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    await this.pool.query(`UPDATE submissions SET ${sets.join(", ")} WHERE id = $1`, vals);
  }

  async finishJob(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE publish_jobs SET state = 'done', locked_by = NULL, locked_until = NULL, updated_at = now() WHERE submission_id = $1`,
      [id],
    );
  }

  /** Record a failure and schedule a retry with exponential backoff (10 s doubling, capped at 1 h). */
  async failJob(id: string, attempts: number): Promise<Date> {
    const delay = Math.min(10 * 2 ** Math.max(0, attempts - 1), 3600);
    const { rows } = await this.pool.query(
      `UPDATE publish_jobs SET state = 'failed', attempts = $2, next_attempt_at = now() + make_interval(secs => $3),
              locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE submission_id = $1 RETURNING next_attempt_at`,
      [id, attempts, delay],
    );
    return rows[0]?.next_attempt_at;
  }

  async alertOwner(kind: string, detail: unknown): Promise<void> {
    await this.pool.query(`INSERT INTO owner_alerts (kind, detail) VALUES ($1, $2)`, [kind, JSON.stringify(detail)]);
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
