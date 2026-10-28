import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../data/context.js";
import { useI18n } from "../../i18n/index.js";
import type { JobStatus } from "../../lib/api.js";
import { errorText, useMod } from "./common.js";

/** The publisher's step order (services/publisher stepNames); the API returns steps in JSONB key order. */
const STEP_ORDER = ["decrypt", "checks", "media", "ipfs", "pin", "torrent", "manifest", "nostr", "chain:", "arweave"];
const LAST_STEPS = ["storage-receipt", "finalize"];
const stepRank = (name: string) => {
  const last = LAST_STEPS.indexOf(name);
  if (last >= 0) return STEP_ORDER.length + 1 + last;
  const i = STEP_ORDER.findIndex((s) => (s.endsWith(":") ? name.startsWith(s) : name === s));
  return i >= 0 ? i : STEP_ORDER.length;
};

/** Publishing job status per submission: each pipeline step, attempts and errors (spec §5.1). */
export function Jobs() {
  const { t, date } = useI18n();
  const app = useApp();
  const { api, me } = useMod();
  const [jobs, setJobs] = useState<JobStatus[] | null>(null);
  const [error, setError] = useState<string>();
  const isOwner = me === app.owner;
  const load = useCallback(() => {
    api.jobs().then(setJobs, (e: unknown) => {
      setJobs([]);
      setError(errorText(e));
    });
  }, [api]);
  useEffect(load, [load]);
  return (
    <section data-testid="jobs">
      <div className="row-between">
        <h2>{t("mod.jobs")}</h2>
        <button type="button" className="secondary" onClick={load}>
          {t("common.refresh")}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      {jobs === null && <p className="muted">{t("common.loading")}</p>}
      {jobs?.length === 0 && !error && <p className="muted">{t("mod.noJobs")}</p>}
      <ul className="list">
        {jobs?.map((j) => (
          <li key={j.submissionId} className="job">
            <div>
              <span className="mono">{j.submissionId.slice(0, 8)}</span>{" "}
              <span className={`state job-${j.state}`}>{t(`job.${j.state}`)}</span>
              <span className="muted small"> · {t("mod.attempts", { n: j.attempts })}</span>
              {j.updatedAt && <span className="muted small"> · {date(j.updatedAt, true)}</span>}
            </div>
            <ul className="steps">
              {Object.entries(j.steps ?? {})
                .sort(([a], [b]) => stepRank(a) - stepRank(b))
                .map(([name, s]) => (
                  <li key={name} className={s.done ? "ok" : s.error ? "error" : "muted"}>
                    {s.done ? "✓" : s.error ? "✗" : "…"} {name}
                    {s.error && <span className="small"> · {s.error}</span>}
                  </li>
                ))}
            </ul>
            {isOwner && j.state === "failed" && (
              <button
                type="button"
                className="secondary"
                onClick={() => void api.retryJob(j.submissionId).then(load, (e: unknown) => setError(errorText(e)))}
              >
                {t("mod.retry")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
