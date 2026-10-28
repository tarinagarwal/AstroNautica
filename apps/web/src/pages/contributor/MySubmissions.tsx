import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toPubkeyHex } from "@core/keys.js";
import { useApp } from "../../data/context.js";
import { useI18n } from "../../i18n/index.js";
import { Api, type MySubmission } from "../../lib/api.js";
import type { Signer } from "../../lib/signer.js";
import { correctionOf, listDrafts, saveDraft, type Draft } from "./draft.js";

function FeedbackText({ signer, moderator, ciphertext }: { signer: Signer; moderator: string; ciphertext: string }) {
  const { t } = useI18n();
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const out = await signer.nip44Decrypt(toPubkeyHex(moderator), ciphertext);
        if (!c) setText(out);
      } catch {
        if (!c) setFailed(true);
      }
    })();
    return () => {
      c = true;
    };
  }, [signer, moderator, ciphertext]);
  if (failed) return <p className="error small">{t("contrib.feedbackUnreadable")}</p>;
  return (
    <blockquote className="feedback" data-testid="feedback">
      {text ?? t("common.loading")}
    </blockquote>
  );
}

/** The contributor's submissions with their state and moderator feedback (NIP-44, decrypted on this device). */
export function MySubmissions({ signer }: { signer: Signer }) {
  const app = useApp();
  const { t, date } = useI18n();
  const nav = useNavigate();
  const [subs, setSubs] = useState<MySubmission[] | null>(null);
  const [error, setError] = useState<string>();
  const [drafts, setDrafts] = useState<Draft[]>([]);

  useEffect(() => {
    void listDrafts().then(setDrafts);
    new Api(app.config.apiUrl, signer).mySubmissions().then(setSubs, (e: unknown) => {
      setSubs([]);
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [app.config.apiUrl, signer]);

  const draftFor = (s: { storyId: string; version: number }) =>
    drafts.find((d) => d.storyId === s.storyId && d.version === s.version);
  const submittedIds = new Set((subs ?? []).map((s) => `${s.storyId}:${s.version}`));
  const unsent = drafts.filter((d) => !submittedIds.has(`${d.storyId}:${d.version}`));

  const correct = async (s: MySubmission) => {
    const base = draftFor(s);
    const story = await app.getStory(s.storyId);
    if (!base || !story) return setError(t("contrib.correctionUnavailable"));
    const next = correctionOf(base, story.ref.version, story.ref.manifestSha256);
    await saveDraft(next);
    nav(`/contribute/edit/${next.storyId}/${next.version}`);
  };

  return (
    <div data-testid="my-submissions">
      {unsent.length > 0 && (
        <section>
          <h2>{t("contrib.drafts")}</h2>
          <ul className="list">
            {unsent.map((d) => (
              <li key={`${d.storyId}:${d.version}`}>
                <Link to={`/contribute/edit/${d.storyId}/${d.version}`}>
                  {d.title.en || d.title.hi || t("contrib.untitled")}
                </Link>
                <span className="muted small"> · {date(d.updatedAt, true)}</span>
                {d.submissionId && <span className="pill">{t("contrib.uploadPending")}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2>{t("contrib.mine")}</h2>
        {error && <p className="error small">{error}</p>}
        {subs === null && <p className="muted">{t("common.loading")}</p>}
        {subs?.length === 0 && !error && <p className="muted">{t("contrib.none")}</p>}
        <ul className="list">
          {subs?.map((s) => {
            const d = draftFor(s);
            return (
              <li key={s.id} className="submission">
                <div>
                  <strong>{d ? d.title.en || d.title.hi : s.storyId}</strong>{" "}
                  <span className={`state state-${s.state}`}>{t(`state.${s.state}`)}</span>
                  {s.version > 1 && (
                    <span className="muted small"> · {t("contrib.version", { version: s.version })}</span>
                  )}
                </div>
                <p className="muted small">{t("contrib.updated", { date: date(s.updatedAt, true) })}</p>
                {(s.feedback ?? []).map((f, i) => (
                  <div key={i}>
                    <p className="small">
                      {t(f.kind === "reject" ? "contrib.rejectedBecause" : "contrib.changesRequested")} ·{" "}
                      {date(f.at, true)}
                    </p>
                    <FeedbackText signer={signer} moderator={f.moderator} ciphertext={f.nip44} />
                  </div>
                ))}
                <p>
                  {(s.state === "changes_requested" || s.state === "draft") && d && (
                    <Link to={`/contribute/edit/${d.storyId}/${d.version}`}>
                      {s.state === "draft" ? t("contrib.resume") : t("contrib.editResubmit")}
                    </Link>
                  )}
                  {(s.state === "changes_requested" || s.state === "draft") && !d && (
                    <span className="muted small">{t("contrib.draftMissing")}</span>
                  )}
                  {s.state === "published" && (
                    <>
                      <Link to={`/story/${s.storyId}`}>{t("contrib.view")}</Link>{" "}
                      {d && (
                        <button type="button" className="link" onClick={() => void correct(s)}>
                          {t("contrib.correct")}
                        </button>
                      )}
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
