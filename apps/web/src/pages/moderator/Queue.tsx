import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { hexToNpub } from "@core/keys.js";
import { useI18n } from "../../i18n/index.js";
import type { QueueItem } from "../../lib/api.js";
import { errorText, useMod } from "./common.js";

export function Queue() {
  const { t, date } = useI18n();
  const { api, me } = useMod();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    setError(undefined);
    api.queue().then(setItems, (e: unknown) => {
      setItems([]);
      setError(errorText(e));
    });
  }, [api]);
  useEffect(load, [load]);
  return (
    <section data-testid="queue">
      <div className="row-between">
        <h2>{t("mod.queue")}</h2>
        <button type="button" className="secondary" onClick={load}>
          {t("common.refresh")}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      {items === null && <p className="muted">{t("common.loading")}</p>}
      {items?.length === 0 && !error && <p className="muted">{t("mod.queueEmpty")}</p>}
      <ul className="list">
        {items?.map((s) => {
          const claimed = s.claimBy && s.claimUntil && Date.parse(s.claimUntil) > Date.now();
          return (
            <li key={s.id}>
              <Link to={`/moderate/review/${s.id}`}>{t("mod.submission", { id: s.id.slice(0, 8) })}</Link>{" "}
              <span className={`state state-${s.state}`}>{t(`state.${s.state}`)}</span>
              {s.version > 1 && <span className="muted small"> · {t("contrib.version", { version: s.version })}</span>}
              <p className="muted small">
                {s.submittedAt && t("mod.submittedAt", { date: date(s.submittedAt, true) })}
                {claimed && (
                  <>
                    {" · "}
                    {s.claimBy === me
                      ? t("mod.claimedByYou")
                      : t("mod.claimedBy", { who: hexToNpub(s.claimBy!).slice(0, 12) + "…" })}
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
