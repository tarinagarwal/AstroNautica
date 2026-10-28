-- Additive to the contract (documented under "Deviations" in docs/architecture.md):
--  * submission_events keeps the full history of a submission (spec 5.1: "The full history is kept"), including a
--    snapshot of the previous encrypted body whenever a contributor edits after a change request.
--  * staging_purged_at records when the retention job deleted a submission's staging data.

CREATE TABLE submission_events (
  id                bigserial PRIMARY KEY,
  submission_id     uuid NOT NULL REFERENCES submissions(id),
  at                timestamptz NOT NULL DEFAULT now(),
  actor             text NOT NULL,
  event             text NOT NULL,   -- created|edited|submitted|claimed|approved|rejected|changes_requested|unlisted|keys_added
  from_state        submission_state,
  to_state          submission_state,
  detail            jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX submission_events_submission_idx ON submission_events (submission_id, id);

ALTER TABLE submissions ADD COLUMN staging_purged_at timestamptz;
