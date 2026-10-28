import { describe, expect, it } from "vitest";
import { createPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { createDatabase, TEST_DB_URL } from "./helpers.js";

describe("migrations", () => {
  it("creates the contract schema once and is idempotent, also when run concurrently", async () => {
    const db = await createDatabase();
    const pool = createPool(db.url, 4);
    try {
      const runs = await Promise.all([runMigrations(pool), runMigrations(pool)]);
      expect(runs.flat().sort()).toEqual([
        "001_init.sql",
        "002_history_and_retention.sql",
        "003_auth_replay.sql",
        "004_db_roles.sql",
      ]);
      expect(await runMigrations(pool)).toEqual([]);
      const tables = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        "audit_events",
        "auth_replay",
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

describe("least-privilege database roles", () => {
  it("creates NOLOGIN group roles with exactly the grants each service needs", async () => {
    const db = await createDatabase();
    const pool = createPool(db.url, 2);
    try {
      await runMigrations(pool);
      const roles = await pool.query(
        "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname IN ('azaad_api_role', 'azaad_publisher_role') ORDER BY rolname",
      );
      expect(roles.rows).toEqual([
        { rolname: "azaad_api_role", rolcanlogin: false, rolsuper: false },
        { rolname: "azaad_publisher_role", rolcanlogin: false, rolsuper: false },
      ]);
      const has = async (role: string, table: string, priv: string) =>
        (await pool.query("SELECT has_table_privilege($1, $2, $3) AS ok", [role, table, priv])).rows[0].ok as boolean;
      const col = async (role: string, table: string, column: string, priv: string) =>
        (await pool.query("SELECT has_column_privilege($1, $2, $3, $4) AS ok", [role, table, column, priv])).rows[0]
          .ok as boolean;

      // publisher: read submissions and contributors, update only the publish fields, jobs, alerts
      const P = "azaad_publisher_role";
      expect(await has(P, "submissions", "SELECT")).toBe(true);
      expect(await has(P, "contributors", "SELECT")).toBe(true);
      for (const c of ["state", "manifest_sha256", "manifest_cid", "published_at", "updated_at"])
        expect(await col(P, "submissions", c, "UPDATE"), c).toBe(true);
      for (const c of ["approval", "publisher_wrapped_key", "body_ciphertext", "contributor", "wrapped_keys"])
        expect(await col(P, "submissions", c, "UPDATE"), c).toBe(false);
      expect(await has(P, "submissions", "INSERT")).toBe(false);
      expect(await has(P, "submissions", "DELETE")).toBe(false);
      expect(await has(P, "contributors", "UPDATE")).toBe(false);
      expect(await has(P, "publish_jobs", "SELECT")).toBe(true);
      expect(await has(P, "publish_jobs", "UPDATE")).toBe(true);
      expect(await has(P, "publish_jobs", "DELETE")).toBe(false);
      expect(await has(P, "owner_alerts", "INSERT")).toBe(true);
      expect(await has(P, "owner_alerts", "SELECT")).toBe(false);
      for (const t of [
        "audit_events",
        "invites_used",
        "invites_revoked",
        "rate_events",
        "auth_replay",
        "submission_events",
      ])
        expect(await has(P, t, "SELECT"), t).toBe(false);
      expect(
        (await pool.query("SELECT has_sequence_privilege($1, 'owner_alerts_id_seq', 'USAGE') AS ok", [P])).rows[0].ok,
      ).toBe(true);

      // api: its own tables, append-only audit log, no schema_migrations
      const A = "azaad_api_role";
      for (const t of [
        "contributors",
        "submissions",
        "publish_jobs",
        "owner_alerts",
        "submission_events",
        "auth_replay",
      ])
        expect(await has(A, t, "UPDATE"), t).toBe(true);
      expect(await has(A, "audit_events", "INSERT")).toBe(true);
      expect(await has(A, "audit_events", "UPDATE")).toBe(false);
      expect(await has(A, "audit_events", "DELETE")).toBe(false);
      expect(await has(A, "submissions", "DELETE")).toBe(false);
      expect(await has(A, "rate_events", "DELETE")).toBe(true);
      expect(await has(A, "schema_migrations", "SELECT")).toBe(false);
    } finally {
      await pool.end();
      await db.drop();
    }
  });

  it("works end to end: a LOGIN member of the publisher role can do the publisher's job and nothing more", async () => {
    const db = await createDatabase();
    const pool = createPool(db.url, 2);
    const user = `pub_t_${Math.random().toString(16).slice(2, 10)}`;
    try {
      await runMigrations(pool);
      await pool.query(`CREATE ROLE ${user} LOGIN PASSWORD 'pw' IN ROLE azaad_publisher_role`);
      await pool.query(
        `INSERT INTO contributors (pubkey, invite_id, redemption) VALUES ('c', 'i', '{}');
         INSERT INTO submissions (id, story_id, version, contributor, body_ciphertext, wrapped_keys, state)
           VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-7000-8000-000000000001', 1, 'c', 'x', '{}', 'approved');
         INSERT INTO publish_jobs (submission_id) VALUES ('00000000-0000-4000-8000-000000000001');`,
      );
      const u = new URL(db.url);
      u.username = user;
      u.password = "pw";
      const pub = createPool(u.toString(), 1);
      try {
        const job = await pub.query(
          `UPDATE publish_jobs SET state = 'running' WHERE submission_id = (
             SELECT submission_id FROM publish_jobs WHERE state = 'pending' FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING submission_id`,
        );
        expect(job.rowCount).toBe(1);
        await pub.query(
          "UPDATE submissions SET state = 'published', manifest_cid = 'b', published_at = now(), updated_at = now() WHERE id = $1",
          [job.rows[0].submission_id],
        );
        await pub.query("INSERT INTO owner_alerts (kind, detail) VALUES ('publish_failed', '{}')");
        await expect(
          pub.query("UPDATE submissions SET publisher_wrapped_key = 'k' WHERE id = $1", [job.rows[0].submission_id]),
        ).rejects.toThrow(/permission denied/);
        await expect(pub.query("SELECT * FROM audit_events")).rejects.toThrow(/permission denied/);
        await expect(pub.query("DELETE FROM publish_jobs")).rejects.toThrow(/permission denied/);
      } finally {
        await pub.end();
      }
    } finally {
      await pool.end();
      await db.drop();
      const admin = createPool(TEST_DB_URL, 1);
      await admin.query(`DROP ROLE IF EXISTS ${user}`);
      await admin.end();
    }
  });
});
