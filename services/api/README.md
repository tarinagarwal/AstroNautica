# @azaadawaaz/api

The staging and moderation service (spec §2, §3, §5, §11, §12; contract in `docs/architecture.md`): invites, NIP-98
auth, the encrypted staging store, the moderation queue and state machine, the audit log, owner alerts and publish job
status. Fastify 5 + PostgreSQL 16. It never sees plaintext: bodies and media arrive encrypted by the contributor's
client and are only decrypted by moderators' clients and, after approval, the publisher.

## Run

```sh
pnpm install
pnpm --filter @azaadawaaz/schema build && pnpm --filter @azaadawaaz/core build
pnpm --filter @azaadawaaz/api migrate      # optional: main also migrates on start unless AUTO_MIGRATE=false
pnpm --filter @azaadawaaz/api dev          # tsx watch; or: build && start
```

In development every setting falls back to `.dev/config.json` (from `scripts/dev-setup.mjs`): owner key, relays,
API URL, database URL and staging dir. The signed lists (moderators with X25519 keys, service keys, relays…) are loaded
from the relays every 30 s; set `BOOTSTRAP_LIST_EVENTS` to a JSON file of signed list events to start offline. Until
the owner's `moderators` and `service-keys` lists are known, creating submissions answers `503 lists_unavailable`.

Retention cleanup runs every `CLEANUP_INTERVAL_MINUTES` inside the server, or once with
`pnpm --filter @azaadawaaz/api cleanup`.

Docker (build context = repository root, as in `infra/prod/docker-compose.yml`):

```sh
docker build -f services/api/Dockerfile -t azaadawaaz/api .
```

The image runs as the unprivileged `node` user, listens on `PORT` (3000 in the image) on `0.0.0.0`, and works with a
read-only root file system (it only writes to `STAGING_DIR`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address (`0.0.0.0` in the image) |
| `PUBLIC_URL` | `.dev` `apiUrl`, else `http://127.0.0.1:$PORT` | Base URL(s) clients sign in NIP-98 `u` tags. Comma-separated for several doors; all must share one path, which becomes the route prefix (e.g. `https://azaadawaaz.org/api`) |
| `DATABASE_URL` | `.dev` `databaseUrl` | Postgres URL. Or `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`/`DATABASE_PASSWORD_FILE` |
| `STAGING_DIR` | `.dev` `stagingDir` | Encrypted blob store (shared with the publisher) |
| `OWNER_PUBKEY` | `.dev` `ownerPubkey` | Pinned owner key, npub or hex |
| `RELAYS` | `.dev` `relays` | Relays to load lists from; audit events go to the `own` relays of the signed relay list, else here |
| `BOOTSTRAP_LIST_EVENTS` | – | Path to a JSON array of signed list events |
| `LISTS_REFRESH_SECONDS` | `30` | List reload interval |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | CORS origins (explicit list, no credentials) |
| `CLAIM_MINUTES` | `30` | Advisory claim length |
| `UNLIST_PER_HOUR` | `5` | Unlistings per moderator per hour (the owner is not limited) |
| `SUBMISSIONS_PER_HOUR` | `30` | New submissions per contributor key per hour |
| `REJECTED_RETENTION_DAYS` | `30` | Staging retention for rejected submissions |
| `DRAFT_RETENTION_DAYS` | `30` | `draft` / `changes_requested` submissions not updated for this long expire: staging and ciphertext are deleted, further writes answer `410 submission_expired` |
| `CLEANUP_INTERVAL_MINUTES` | `60` | Retention job interval |
| `MAX_IMAGE_BYTES` | `20MB` | Per image (plaintext) |
| `MAX_VIDEO_BYTES` | `2GB` | Per video (plaintext) |
| `MAX_BLOCKS` | `100` | Blocks per story; media items per submission are also capped at 20 × this |
| `MAX_MEDIA_PER_SUBMISSION` | `200` | Media items per submission |
| `MAX_SUBMISSION_BYTES` | `4GB` | Total declared media bytes of one submission (`413 submission_too_large`) |
| `MAX_CONTRIBUTOR_STAGING_BYTES` | `8GB` | Total declared media bytes of one contributor's submissions still in progress (not rejected/published/unlisted, staging not deleted) (`413 staging_quota_exceeded`) |
| `MAX_JSON_BYTES` | `8MB` | JSON body limit (chunk uploads are limited to 1 MiB + 17 bytes) |
| `AUTO_MIGRATE` | `true` | Apply migrations on start. Production sets `false`: a one-shot `migrate` service runs them as the database owner, and the API connects as a member of `azaad_api_role` |
| `LOG_LEVEL` | `info` | pino level |
| `TRUST_PROXY` | – | Only `false` is accepted: the API never reads client addresses |

Sizes accept plain bytes or binary suffixes (`20MB` = 20 MiB). See `.env.example`.

## Behaviour worth knowing

- **Auth:** `Authorization: Nostr <base64 kind-27235 event>`, `u` = public URL + path + query, `method`, and `payload`
  = SHA-256 of the raw body for every request with a body. Events must be within 60 s of server time. An accepted
  event id is stored in Postgres (`auth_replay`) until its `created_at` + 61 s, so a replay fails across restarts and
  replicas; two byte-identical requests signed in the same second are a replay (add a nonce tag). Any malformed auth
  event (bad JSON, non-array `tags`, non-string tag values, a non-integer `created_at`, …) is `401`, never `500`.
- **Roles:** owner = pinned key; moderator = active on the owner-signed moderator list, or the owner; contributor =
  redeemed an invite and not revoked (in the database or on any moderator's signed `revoked-contributors` list).
  Revoked contributors can still read their own submissions. Revocation that the publisher honours is the database's
  `revoked_at` (set by `POST /contributors/:pubkey/revoke`).
- **No self-review:** a moderator (or the owner) cannot approve, reject or request changes on a submission whose
  contributor key is their own (`403`).
- **Quotas and expiry:** see `MAX_SUBMISSION_BYTES`, `MAX_CONTRIBUTOR_STAGING_BYTES`, `MAX_MEDIA_PER_SUBMISSION` and
  `DRAFT_RETENTION_DAYS`; uploads must match the declared sizes exactly, so the declared sizes bound the disk use.
  `GET /config` returns them under `limits`.
- **State machine:** `src/stateMachine.ts` holds every transition; each one is a single guarded
  `UPDATE … WHERE state = ANY(…)`, so concurrent approvals produce exactly one `approved` (the other gets `409`).
  Decisions (approve, reject, request changes) need `in_review`, i.e. a claim first; claims are advisory and expire.
- **Wrapped keys:** `wrappedKeys` must cover the owner's and every active moderator's X25519 key, may include extra
  keys of the contributor's own, and must never include a publisher key. `GET /rewrap-needed` + `POST
  /submissions/:id/keys` let a moderator add wraps for new moderators (existing wraps are never replaced).
- **Media:** `PUT …/header` (24 bytes) and `PUT …/chunks/:n` (exactly 1 MiB + 17 bytes, the last chunk
  `size − (chunks−1)·1 MiB + 17`), `GET …/status` to resume, `POST …/complete` to seal. Any re-upload clears
  `complete`. Files land in `<STAGING_DIR>/<submission id>/<sha256>/{header,<n>}`.
- **Audit:** kind 9737 events signed by the caller, content empty, `["action", …]`, plus `["s", sha256(id)]` for
  submission actions, `["story", id]` for approve/unlist (never for reject/request changes), `["p", pubkey]` for
  revoke/mute, `["e", id]` for hide. Stored in `audit_events` and forwarded to our own relays.
- **Privacy:** `trustProxy: false`; logs contain only method, route pattern, status and timings — no addresses,
  headers, ids or pino `hostname`/`pid`.

## Database roles

Migration `004_db_roles.sql` creates two `NOLOGIN` group roles with least-privilege grants:

- `azaad_api_role`: what the API uses (no `DELETE` except on `rate_events`/`auth_replay`, the audit and invite tables
  are append-only, no access to `schema_migrations`);
- `azaad_publisher_role`: `SELECT` on `submissions` and `contributors`; `UPDATE` on `submissions(state,
  manifest_sha256, manifest_cid, published_at, updated_at)` only; `SELECT`/`UPDATE` on `publish_jobs`; `INSERT` on
  `owner_alerts` (+ its sequence).

Deployments create `LOGIN` users that are members of these roles (`infra/prod/postgres/init-users.sh`) and run the
migrations as the database owner. A migration that adds a table must grant on it explicitly. The tests run the server
as a throwaway member of `azaad_api_role`, so a missing grant fails them.

## Test

The integration tests need a real Postgres. They create (and drop) one database per test file on it:

```sh
docker compose -f ../../infra/dev/docker-compose.yml up -d postgres   # creates azaadawaaz_test too
pnpm --filter @azaadawaaz/api test          # TEST_DATABASE_URL defaults to postgres://azaad:azaad@127.0.0.1:5432/azaadawaaz_test
docker rm -f api-test-pg
```
