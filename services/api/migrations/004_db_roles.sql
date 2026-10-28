-- Least-privilege database roles (docs/architecture.md, Deviations). NOLOGIN group roles: deployments create LOGIN
-- users that are members of them (infra/prod/postgres/init-users.sh creates `api` and `publisher`), and run the
-- migrations as the database owner. Roles are cluster-wide, so creating them is idempotent (and safe when several
-- databases are migrated at once); the grants are per database.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['azaad_api_role', 'azaad_publisher_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL; -- created concurrently by another migration run
      END;
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO azaad_api_role, azaad_publisher_role;

-- The API: everything it reads and writes, nothing it never needs (no DELETE except on the pruned tables, no
-- UPDATE of the append-only audit and invite tables, no access to schema_migrations: AUTO_MIGRATE=false).
GRANT SELECT, INSERT, UPDATE ON contributors TO azaad_api_role;
GRANT SELECT, INSERT ON invites_used, invites_revoked, audit_events TO azaad_api_role;
GRANT SELECT, INSERT, UPDATE ON submissions, submission_events, publish_jobs, owner_alerts TO azaad_api_role;
GRANT SELECT, INSERT, DELETE ON rate_events TO azaad_api_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_replay TO azaad_api_role;
GRANT USAGE, SELECT ON SEQUENCE owner_alerts_id_seq, submission_events_id_seq TO azaad_api_role;

-- The publisher (docs/architecture.md: it reads and writes only submissions' state and publish fields and
-- publish_jobs; it checks contributors' revocation and raises owner alerts).
GRANT SELECT ON submissions, contributors TO azaad_publisher_role;
GRANT UPDATE (state, manifest_sha256, manifest_cid, published_at, updated_at) ON submissions TO azaad_publisher_role;
GRANT SELECT, UPDATE ON publish_jobs TO azaad_publisher_role;
GRANT INSERT ON owner_alerts TO azaad_publisher_role;
GRANT USAGE ON SEQUENCE owner_alerts_id_seq TO azaad_publisher_role;
