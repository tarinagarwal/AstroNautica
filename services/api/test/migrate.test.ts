import { describe, expect, it } from "vitest";
import { createPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { createDatabase } from "./helpers.js";

describe("migrations", () => {
  it("creates the contract schema once and is idempotent, also when run concurrently", async () => {
    const db = await createDatabase();
    const pool = createPool(db.url, 4);
    try {
      const runs = await Promise.all([runMigrations(pool), runMigrations(pool)]);
      expect(runs.flat().sort()).toEqual(["001_init.sql", "002_history_and_retention.sql"]);
      expect(await runMigrations(pool)).toEqual([]);
      const tables = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        "audit_events",
        "contributors",
        "invites_revoked",
        "invites_used",
        "owner_alerts",
        "publish_jobs",
        "rate_events",
        "schema_migrations",
        "submission_events",
        "submissions",
      ]);
      const states = await pool.query("SELECT unnest(enum_range(NULL::submission_state))::text AS s");
      expect(states.rows.map((r) => r.s)).toEqual([
        "draft",
        "submitted",
        "in_review",
        "changes_requested",
        "rejected",
        "approved",
        "publishing",
        "published",
        "unlisted",
      ]);
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});
