import type { PublisherDb } from "./db.js";
import type { Pipeline } from "./pipeline.js";

/** Poll for due jobs and run them; failures are retried with backoff by `failJob`. */
export class Worker {
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: PublisherDb,
    private readonly pipeline: Pipeline,
    private readonly opts: { workerId: string; pollMs: number; log: (m: string, x?: Record<string, unknown>) => void },
  ) {}

  /** Run one due job if there is one. Returns true if a job was processed (successfully or not). */
  async tick(): Promise<boolean> {
    const job = await this.db.claimJob(this.opts.workerId);
    if (!job) return false;
    try {
      await this.pipeline.run(job);
      this.opts.log("job done", { submission: job.submission_id });
    } catch (e) {
      const attempts = job.attempts + 1;
      const next = await this.db.failJob(job.submission_id, attempts);
      this.opts.log("job failed; will retry", { submission: job.submission_id, attempts, next, error: String(e) });
      if (attempts === 5) await this.db.alertOwner("publish_failed", { submission: job.submission_id, error: String(e) });
    }
    return true;
  }

  start(): void {
    const loop = async () => {
      while (!this.stopped) {
        let worked = false;
        try {
          worked = await this.tick();
        } catch (e) {
          this.opts.log("worker error", { error: String(e) });
        }
        if (!worked) await new Promise((r) => setTimeout(r, this.opts.pollMs));
      }
    };
    this.running = loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }
}
