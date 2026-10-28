-- Initial schema: exactly the contract in docs/architecture.md ("Database"), plus indexes.

CREATE TYPE submission_state AS ENUM
  ('draft','submitted','in_review','changes_requested','rejected','approved','publishing','published','unlisted');

CREATE TABLE contributors (
  pubkey            text PRIMARY KEY,
  invite_id         text NOT NULL,
  redemption        jsonb NOT NULL,
  redeemed_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);

CREATE TABLE invites_used (
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
  id                uuid PRIMARY KEY,
  story_id          uuid NOT NULL,
  version           integer NOT NULL CHECK (version >= 1),
  supersedes        text,
  contributor       text NOT NULL REFERENCES contributors(pubkey),
  state             submission_state NOT NULL DEFAULT 'draft',
  body_ciphertext   text NOT NULL,
  wrapped_keys      jsonb NOT NULL,
  media             jsonb NOT NULL DEFAULT '[]',
  claim_by          text,
  claim_until       timestamptz,
  approval          jsonb,
  approval_body_sha256 text,
  publisher_wrapped_key text,
  feedback          jsonb,
  manifest_sha256   text,
  manifest_cid      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz,
  decided_at        timestamptz,
  published_at      timestamptz,
  UNIQUE (story_id, version)
);
CREATE INDEX submissions_state_idx ON submissions (state, submitted_at);
CREATE INDEX submissions_contributor_idx ON submissions (contributor, created_at);

CREATE TABLE audit_events (
  id                text PRIMARY KEY,
  submission_id     uuid REFERENCES submissions(id),
  actor             text NOT NULL,
  action            text NOT NULL,
  event             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);

CREATE TABLE publish_jobs (
  submission_id     uuid PRIMARY KEY REFERENCES submissions(id),
  state             text NOT NULL DEFAULT 'pending',
  steps             jsonb NOT NULL DEFAULT '{}',
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  locked_by         text,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE owner_alerts (
  id                bigserial PRIMARY KEY,
  kind              text NOT NULL,
  detail            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  seen_at           timestamptz
);

CREATE TABLE rate_events (
  pubkey            text NOT NULL,
  action            text NOT NULL,
  at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rate_events (pubkey, action, at);
