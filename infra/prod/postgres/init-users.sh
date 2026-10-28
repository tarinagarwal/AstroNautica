#!/bin/sh
# Least-privilege database users for AzaadAwaaz (infra/prod/README.md, "Database users").
#
# Runs once from /docker-entrypoint-initdb.d when the postgres volume is first initialised. On an
# existing database run it by hand (it is idempotent and also rotates the passwords):
#   docker compose exec postgres sh /docker-entrypoint-initdb.d/10-azaad-users.sh
#
# Creates the NOLOGIN group roles (the same ones services/api migration 004 creates and grants to)
# and the LOGIN users `api` and `publisher` as members of them, with passwords from Docker secrets.
# Grants on tables come from the migrations, which the one-shot `migrate` service applies as the
# database owner ($POSTGRES_USER).
set -eu

API_PASSWORD_FILE=${API_PASSWORD_FILE:-/run/secrets/postgres_api_password}
PUBLISHER_PASSWORD_FILE=${PUBLISHER_PASSWORD_FILE:-/run/secrets/postgres_publisher_password}

read_secret() {
  if [ ! -s "$1" ]; then
    echo "init-users: missing or empty secret $1" >&2
    exit 1
  fi
  # Files are written without a trailing newline (secrets/README.md); strip one if present.
  tr -d '\n' <"$1"
}

api_pw=$(read_secret "$API_PASSWORD_FILE")
publisher_pw=$(read_secret "$PUBLISHER_PASSWORD_FILE")

# Passwords reach psql through its environment (\getenv), not the command line, and go into the SQL as
# :'name' variables, which psql quotes as literals: never pasted into the SQL text.
AZAAD_API_PW=$api_pw AZAAD_PUBLISHER_PW=$publisher_pw \
  psql -v ON_ERROR_STOP=1 -q --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" <<'SQL'
SET client_min_messages = warning;
\getenv api_pw AZAAD_API_PW
\getenv publisher_pw AZAAD_PUBLISHER_PW
SELECT format('CREATE ROLE %I NOLOGIN', r)
  FROM unnest(ARRAY['azaad_api_role', 'azaad_publisher_role']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec
SELECT format('CREATE ROLE %I LOGIN', u)
  FROM unnest(ARRAY['api', 'publisher']) AS u
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = u)
\gexec
ALTER ROLE api WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'api_pw';
ALTER ROLE publisher WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'publisher_pw';
GRANT azaad_api_role TO api;
GRANT azaad_publisher_role TO publisher;
-- Neither user may create objects anywhere (PostgreSQL 15+ already revokes CREATE on public from PUBLIC).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
echo "init-users: database users api and publisher are ready"
