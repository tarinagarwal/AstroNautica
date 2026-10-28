# Architecture and internal contracts

This file pins the interfaces between packages and services so they can be built in parallel. The spec
(`docs/SPEC.md`) says *what*; this says *exactly how the pieces talk*. Change it only together with every side.

## Packages

| Package | Runs in | Purpose |
|---|---|---|
| `packages/schema` | everywhere | Manifest types, JCS, hashing, `approvalBody()`, validation, UUIDv7 |
| `packages/core` | everywhere | Keys, signed lists, verified fetching, stories, comments, staging crypto, NIP-98 auth, invites, i18n, relay pool |
| `packages/media-strip` | browser, React Native, Node | Lossless metadata stripping for JPEG, PNG, WebP and MP4/MOV, plus a checker that reports leftover metadata |
| `packages/contracts` | Foundry + TS | `AzaadAwaazRegistry`, ABI, chain config |
| `services/api` | Node 22 | Invites, auth, staging store, moderation queue, audit log |
| `services/media` | Node 22 | Server-side processing: image variants, blurhash, HLS ladder, MP4, poster, preview |
| `services/publisher` | Node 22 | The idempotent publishing pipeline (spec §6) |
| `apps/web` | browser | Static SPA: reader, verify, comments, contributor and moderator areas |
| `apps/android` | React Native | Everything the web does plus Tor, DoH, offline sharing, self-update |

Node services pass `ws` to `RelayPool` (see `packages/core/src/relays.ts`).

## Keys and configuration (dev)

`scripts/dev-setup.mjs` (root) creates, for local development only, clearly labelled **sample keys**: owner, publisher
(Nostr + X25519 + EVM), two moderators (Nostr + X25519), and writes them to `.dev/keys.json` (gitignored). It signs
and publishes the owner lists (moderators, service-keys, relays, gateways) to the local relays, deploys the registry to
both local chains, and writes `.dev/config.json`:

```json
{
  "ownerPubkey": "<hex>",
  "relays": ["ws://127.0.0.1:7777", "ws://127.0.0.1:7778"],
  "ipfsApis": ["http://127.0.0.1:5001", "http://127.0.0.1:5002"],
  "ipfsGateways": ["http://127.0.0.1:8080", "http://127.0.0.1:8081"],
  "arweave": "http://127.0.0.1:1984",
  "chains": [{ "key": "base-local", "chainId": 31337, "rpc": "http://127.0.0.1:8545", "registry": "0x..." },
             { "key": "bsc-local", "chainId": 97, "rpc": "http://127.0.0.1:8546", "registry": "0x..." }],
  "apiUrl": "http://127.0.0.1:8787",
  "databaseUrl": "postgres://azaad:azaad@127.0.0.1:5432/azaadawaaz",
  "stagingDir": ".dev/staging"
}
```

Services read configuration from environment variables (documented in each service's README) with `.dev/config.json`
as the dev fallback.

## Database (PostgreSQL 16), owned by `services/api`

Migrations live in `services/api/migrations/*.sql`, applied in filename order by `services/api/src/migrate.ts`
(tracked in `schema_migrations`). The publisher reads and writes only `submissions` (state and publish fields) and
`publish_jobs`.

```sql
CREATE TYPE submission_state AS ENUM
  ('draft','submitted','in_review','changes_requested','rejected','approved','publishing','published','unlisted');

CREATE TABLE contributors (
  pubkey            text PRIMARY KEY,           -- hex
  invite_id         text NOT NULL,              -- invite event id
  redemption        jsonb NOT NULL,             -- the contributor-signed redemption event
  redeemed_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);

CREATE TABLE invites_used (                     -- invites are owner-signed and verified statelessly; only use is stored
  invite_id         text PRIMARY KEY,
  code_sha256       text UNIQUE NOT NULL,
  contributor       text REFERENCES contributors(pubkey),
  used_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites_revoked (
  invite_id         text PRIMARY KEY,
  revoked_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submissions (
  id                uuid PRIMARY KEY,           -- submission id (random UUID)
  story_id          uuid NOT NULL,              -- UUIDv7 story id (stable across versions)
  version           integer NOT NULL CHECK (version >= 1),
  supersedes        text,                       -- previous manifest sha256 for version > 1
  contributor       text NOT NULL REFERENCES contributors(pubkey),
  state             submission_state NOT NULL DEFAULT 'draft',
  body_ciphertext   text NOT NULL,              -- core.encryptJson(ApprovalBody, contentKey)
  wrapped_keys      jsonb NOT NULL,             -- { "<x25519 hex>": "<sealed box b64url>" } for moderators + owner
  media             jsonb NOT NULL DEFAULT '[]',-- [{ sha256, size, mime, kind: "image"|"video", chunks, header?, complete }]
  claim_by          text,                       -- moderator pubkey
  claim_until       timestamptz,
  approval          jsonb,                      -- Approval (schema type)
  approval_body_sha256 text,                    -- what the moderator says they signed; publisher re-checks
  publisher_wrapped_key text,                   -- content key sealed for the publisher's X25519 key
  feedback          jsonb,                      -- [{ at, moderator, kind: "reject"|"changes", nip44 }] encrypted to contributor
  manifest_sha256   text,
  manifest_cid      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz,
  decided_at        timestamptz,
  published_at      timestamptz,
  UNIQUE (story_id, version)
);

CREATE TABLE audit_events (                     -- every moderation action, as the moderator-signed Nostr event
  id                text PRIMARY KEY,           -- event id
  submission_id     uuid REFERENCES submissions(id),
  actor             text NOT NULL,
  action            text NOT NULL,              -- approve|reject|request_changes|unlist|hide|mute|claim|revoke_contributor
  event             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publish_jobs (
  submission_id     uuid PRIMARY KEY REFERENCES submissions(id),
  state             text NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  steps             jsonb NOT NULL DEFAULT '{}',     -- { "<step>": { done: bool, result?: any, error?: string, attempts: int, at } }
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  locked_by         text,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE owner_alerts (
  id                bigserial PRIMARY KEY,
  kind              text NOT NULL,              -- unlist|unlist_rate_limited|publish_failed|...
  detail            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  seen_at           timestamptz
);

CREATE TABLE rate_events (                      -- per-key rate limiting (no IPs, ever)
  pubkey            text NOT NULL,
  action            text NOT NULL,
  at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rate_events (pubkey, action, at);
```

When a moderator approves, the API sets `state = 'approved'`, stores approval fields, and inserts a `publish_jobs` row
in the same transaction. The publisher claims jobs with `SELECT … FOR UPDATE SKIP LOCKED` where
`state IN ('pending','failed') AND next_attempt_at <= now()` and `(locked_until IS NULL OR locked_until < now())`,
sets `submissions.state = 'publishing'`, and on success `'published'` (spec §5.1: once the manifest is on IPFS and on
≥ 3 relays — in dev with 2 local relays, "all configured own relays").

## Staging blob store

Directory `STAGING_DIR` (shared volume between `api` and `publisher`):

```
<STAGING_DIR>/<submission id>/<media sha256>/header      24 bytes, secretstream header
<STAGING_DIR>/<submission id>/<media sha256>/<n>         chunk n (0-based), ciphertext of ≤ 1 MiB plaintext + 17 bytes
```

Media plaintext is the metadata-stripped original. Its SHA-256 is the `sha256` in the approval body. The publisher
must check the decrypted bytes hash to that value and fail the job otherwise.

Deletion: rejected submissions' directories after `REJECTED_RETENTION_DAYS` (30); approved ones after publishing.

## HTTP API (`services/api`, default `http://127.0.0.1:8787`)

JSON bodies unless noted. Authenticated routes need `Authorization: Nostr <base64 event>` (NIP-98, `core.createAuthHeader`),
with `u` = the full request URL as the client used it (the API compares against `PUBLIC_URL` + path + query) and the
payload hash for bodies. Replayed auth event ids are rejected for 120 s. Roles come from the effective lists
(`core.buildEffectiveLists`, refreshed from relays every 30 s): owner = pinned owner key, moderator = active moderator,
contributor = in `contributors` table and not revoked.

Errors: `{ "error": "<code>", "message": "<human text>" }` with 4xx/5xx.

| Method & path | Role | Body / result |
|---|---|---|
| `GET /health` | – | `{ ok: true }` |
| `GET /config` | – | `{ ownerPubkey, ownerX25519, publisher: { pubkey, x25519 }, moderators: [{ pubkey, x25519 }], relays, gateways, limits }` — the X25519 keys a contributor must wrap for |
| `POST /invites/redeem` | – | `{ redemption: Event }` → `{ contributor: hex }`. Checks owner signature, expiry, not used, not revoked |
| `POST /invites/revoke` | owner | `{ inviteId }` |
| `GET /contributors` | moderator | `[{ pubkey, redeemedAt, revokedAt }]` — moderator clients sync their signed contributors lists from this |
| `POST /contributors/:pubkey/revoke` | owner, moderator | `{ auditEvent }` |
| `POST /submissions` | contributor | `{ storyId, version, supersedes, bodyCiphertext, wrappedKeys, media: [{ sha256, size, mime, kind, chunks }] }` → `{ id }` (state `draft`). `wrappedKeys` must cover the owner and every active moderator |
| `PUT /submissions/:id` | contributor (own, in `draft` or `changes_requested`) | same fields as create |
| `PUT /submissions/:id/media/:sha256/header` | contributor (own) | raw 24 bytes (`application/octet-stream`) |
| `PUT /submissions/:id/media/:sha256/chunks/:n` | contributor (own) | raw bytes; idempotent (re-upload replaces) |
| `GET /submissions/:id/media/:sha256/status` | contributor (own), moderator | `{ received: number[], complete: boolean }` |
| `POST /submissions/:id/media/:sha256/complete` | contributor (own) | checks every chunk 0..chunks-1 and header exist |
| `POST /submissions/:id/submit` | contributor (own) | `draft`/`changes_requested` → `submitted`; all media complete |
| `GET /me/submissions` | contributor | `[{ id, storyId, version, state, feedback, createdAt, updatedAt, manifestCid, publishedAt }]` |
| `GET /submissions/:id` | contributor (own), moderator, owner | full row minus other recipients' wrapped keys: `{ …, wrappedKey: <for the caller's x25519 via ?x25519=> }` |
| `GET /submissions/:id/media/:sha256/header` and `/chunks/:n` | contributor (own), moderator, owner | raw bytes |
| `GET /queue` | moderator | submissions in `submitted`, `in_review` (oldest first), with claim info |
| `POST /submissions/:id/claim` | moderator | sets claim for `CLAIM_MINUTES` (30); `submitted` → `in_review`; advisory |
| `POST /submissions/:id/approve` | moderator | `{ approval, approvalBodySha256, publisherWrappedKey, auditEvent }`. Verifies the approval signature over `approvalMessageHash(approvalBodySha256, approvedAt)` and that the signer is an active moderator. First approval wins (409 afterwards) |
| `POST /submissions/:id/reject` | moderator | `{ feedback: nip44 ciphertext for the contributor, auditEvent }` → `rejected` (final) |
| `POST /submissions/:id/request-changes` | moderator | `{ feedback, auditEvent }` → `changes_requested` |
| `POST /submissions/:id/keys` | moderator, owner | `{ wrappedKeys }` — add wraps for new moderators |
| `GET /rewrap-needed` | moderator, owner | submissions missing wraps for current active moderators |
| `POST /moderation/unlist` | moderator, owner | `{ storyId, auditEvent }` → rate-limited (`UNLIST_PER_HOUR`, 5); every call raises an owner alert |
| `POST /moderation/audit` | moderator, owner | `{ auditEvent }` for hide/mute (stored and forwarded to own relays) |
| `GET /audit` | owner | full audit log, newest first, paginated `?before=` |
| `GET /owner/alerts` | owner | unseen alerts; `POST /owner/alerts/seen` |
| `GET /jobs` | moderator, owner | publish job status per submission (steps, errors) |
| `POST /jobs/:id/retry` | owner | reset `next_attempt_at` |

Audit events are kind `9737` (core `KIND_AUDIT`), signed by the moderator, tags:
`["action", <action>]`, `["s", sha256(submission id)]` (never the plain id or story id for rejected/changes), plus
`["d"…]` none; content is empty. For `approve` and `unlist` also `["story", <story id>]`. The API stores them and
forwards them to the own relays. Feedback text is NIP-44 encrypted to the contributor and only stored in the DB.

The API never logs IP addresses (Fastify `logger` configured without `req.ip`/`remoteAddress`; `trustProxy` off).

## Media processing (`services/media`)

A library (`@azaadawaaz/media`) used by the publisher, plus a CLI for manual runs:

```ts
processImage(bytes: Uint8Array): Promise<{
  original: { bytes; sha256; mime; width; height };   // re-checked metadata-free (via media-strip check)
  variants: { "480"?: { bytes; sha256; width; height }; "960"?: …; "1600"?: … };  // WebP, never upscaled
  blurhash: string;
}>
processVideo(inputPath: string, outDir: string, opts?: { ladder?: (360|720|1080)[] }): Promise<{
  hlsDir: string;              // master.m3u8 + per-rendition playlists + .ts segments (metadata stripped)
  mp4: { path; sha256 };       // 720p (or source height if smaller) fallback
  poster: { path; sha256; width; height };
  preview: { path; sha256 };   // ≤ 6 s, muted, small
  durationSec: number; width: number; height: number;
}>
```

`packages/media-strip` exposes `stripMetadata(bytes, mime) → Uint8Array` and `findMetadata(bytes, mime) → string[]`
(names of leftover metadata such as `"exif"`, `"gps"`, `"xmp"`, `"iptc"`, `"mp4:udta"`, `"mp4:©xyz"`).

## Publisher pipeline steps (`services/publisher`)

Step names in `publish_jobs.steps`, run in order, each idempotent and recorded:
`decrypt` → `checks` → `media` → `ipfs` → `arweave` → `torrent` → `manifest` → `nostr` → `storage-receipt` →
`chain:<key>` (one per configured chain) → `finalize`. The story is marked `published` after `nostr` succeeds on
the required relays; later steps continue and are visible via `GET /jobs`.

## Web app (`apps/web`)

Vite + React + TypeScript static SPA, hash-free routes via `HashRouter` (works from any domain, IPFS path gateways and
onion without server rewrites). Bundled defaults: `apps/web/src/defaults.json` holds the pinned owner key and the
latest owner-signed list events at build time (generated by `scripts/dev-setup.mjs` in dev).

## Deviations

### `services/api`

Additive or clarifying; no field or endpoint of the contract was removed or renamed.

1. **Extra table and column** (migration `002_history_and_retention.sql`): `submission_events` keeps the full history
   of each submission (created, edited, submitted, claimed, approved, rejected, changes_requested, unlisted,
   keys_added). When a contributor edits after a change request, the previous encrypted body, wrapped keys and media
   list are kept in that history (spec §5.1 "the full history is kept"). `submissions.staging_purged_at` records when
   the retention job removed a submission's staging data. `GET /submissions/:id` additionally returns `history`
   (with `previous.wrappedKey` for the caller's `?x25519=`).
2. **`PUBLIC_URL` may list several base URLs** (comma-separated: domains, onion) that share one path; NIP-98 `u` must
   match one of them + path + query. A path in `PUBLIC_URL` (e.g. `https://azaadawaaz.org/api`, matching nginx's
   `/api/` location) becomes the route prefix.
3. **Database settings** may also come as `DATABASE_HOST/PORT/NAME/USER/PASSWORD_FILE` (what
   `infra/prod/docker-compose.yml` passes); `TRUST_PROXY` other than `false` is refused.
4. **Roles:** the owner has every moderator permission (spec §2), including approving. The owner is exempt from the
   unlist rate limit (it limits *moderators*, spec §5.4), but every unlisting by anyone still raises an owner alert.
   Contributor = in `contributors`, not revoked there **and** not on any moderator's signed `revoked-contributors`
   list. Revoked contributors may still read their own submissions (`GET /me/submissions`, `GET /submissions/:id`).
5. **Decisions require `in_review`** (spec §5.1 diagram): approve/reject/request-changes on a `submitted`
   submission answer 409, so moderator clients claim when opening a submission. A claim is advisory: it never blocks
   another moderator's decision, but `POST …/claim` answers `409 claimed` while another moderator's claim is active.
   A claim counts only while unexpired **and** held by a current moderator (removed moderators' claims are released);
   expiry does not change the state. `POST …/claim` optionally takes `{ auditEvent }` (action `claim`).
6. **Audit tag rules for non-submission actions:** `revoke_contributor` and `mute` need `["p", <pubkey>]`, `hide`
   needs `["e", <event id>]`, `unlist` needs `["story", <story id>]` (no `s`). Reject/request-changes events must not
   carry a `story` tag. `created_at` must be within 10 minutes of server time; a reused event id is `409
   audit_replayed`. Approvals' `approvedAt` must be within 10 minutes of server time and `approval.moderator` must be
   the caller.
7. **Wrapped keys:** besides covering the owner and every active moderator, `wrappedKeys` may contain extra recipients
   (e.g. the contributor's own device key, retrievable by that contributor via `?x25519=`) but never a publisher
   X25519 key (`400 publisher_wrap_forbidden`). `POST /submissions/:id/keys` accepts only current owner/moderator keys
   and only adds missing wraps (never replaces); allowed in `draft`, `submitted`, `in_review`, `changes_requested`.
8. **Unlist** also moves the story's `published` submissions to `unlisted` (spec §5.1 diagram); the audit row's
   `submission_id` is the story's latest submission when known.
9. **Retention** additionally clears `body_ciphertext` (to `''`), `wrapped_keys`, `publisher_wrapped_key` and history
   snapshots when it deletes a submission's staging directory (rejected after `REJECTED_RETENTION_DAYS`;
   `published`/`unlisted` at the next run). It also prunes `rate_events` older than a day.
10. **Media rules made explicit:** `size ≥ 1`; `chunks = ceil(size / 1 MiB)`; image MIME ∈ jpeg/png/webp, video MIME
    ∈ mp4/quicktime (what `packages/media-strip` handles); at most `20 × MAX_BLOCKS` media items; chunk uploads must be
    exactly the expected ciphertext length. Upload/complete are allowed in `draft` and `changes_requested` only; any
    re-upload clears `complete`. `GET …/status` also returns `header` and `chunks`.
11. **Status codes:** creations (`POST /submissions`, `POST /invites/redeem`) answer 201. Errors: `invite_expired`
    (400), `invalid_invite` (400), `invite_revoked` (403), `invite_used`/`already_contributor` (409),
    `invalid_state` (409), `rate_limited` (429), `lists_unavailable` (503, until the owner's moderator and
    service-key lists are loaded). Submissions a caller may not read are 404, not 403.
12. **`SUBMISSIONS_PER_HOUR`** (default 30) rate-limits new submissions per contributor key via `rate_events`.

### Deviations → security review fixes (all services)
- **Auth replay:** NIP-98 replay entries are kept in Postgres (`auth_replay`, migration 003) until `created_at + 61 s`,
  so replays fail across restarts and replicas; malformed auth events are 401, never 500.
- **Quotas:** `MAX_SUBMISSION_BYTES` (4 GiB) → 413 `submission_too_large`; `MAX_CONTRIBUTOR_STAGING_BYTES` (8 GiB)
  across non-final submissions → 413 `staging_quota_exceeded`; `MAX_MEDIA_PER_SUBMISSION` (200). Drafts and
  change-requested submissions untouched for `DRAFT_RETENTION_DAYS` (30) expire: staging deleted, ciphertext cleared,
  later edits/uploads answer 410 `submission_expired`. `GET /config` `limits` includes `maxSubmissionBytes`,
  `maxContributorStagingBytes`, `draftRetentionDays`.
- **No self-review:** approve/reject/request-changes on a submission whose contributor is the caller → 403.
- **Database roles** (migration 004): `azaad_api_role` and `azaad_publisher_role` (least privilege; the publisher may
  only update `submissions(state, manifest_sha256, manifest_cid, published_at, updated_at)` and `publish_jobs`, and
  insert `owner_alerts`). Production uses LOGIN users `api` and `publisher`; migrations run as the owner in a one-shot
  `migrate` service.
- **Publish jobs** can be `blocked` (policy failure: revoked contributor, removed moderator, tampered content); the
  publisher stops retrying, wipes its work files and alerts the owner. `POST /jobs/:id/retry` re-queues it.
- **Pipeline:** step order is decrypt → checks → media → ipfs → pin → torrent → manifest → nostr (published) →
  chain:<key>… → arweave → storage-receipt → finalize (decision D12). Media processing runs in the isolated `media`
  worker (`POST /process` on an internal network, shared volume; decision D21).
- **Registry:** `receipt(storyId, version, by)` and `Published(storyId, version, publisher, …)` with all three indexed
  (decision D19).
- **Relays** accept only: 30023 from owner/publishers, 30078 from owner/moderators/publishers, 9737 from
  owner/moderators, 1111/7 with PoW; never kinds 5, 62, 27235 or anything else (decision D20). They learn moderators and
  publishers from the owner's lists (`OWNER_PUBKEY`).
- **Lists:** new owner list `vouched` (decision D17); moderator-list caps per D18.
