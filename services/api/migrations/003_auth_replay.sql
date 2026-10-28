-- NIP-98 replay protection shared by every API process and surviving restarts (docs/architecture.md, Deviations).
-- An auth event id is remembered until its created_at + the accepted clock window + 1 s: after that the event is
-- rejected as expired anyway. The retention job deletes expired rows.

CREATE TABLE auth_replay (
  event_id          text PRIMARY KEY,
  expires_at        timestamptz NOT NULL
);
CREATE INDEX auth_replay_expires_idx ON auth_replay (expires_at);
