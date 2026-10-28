import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { storyLanguages } from "@core/i18n.js";
import { hexToNpub } from "@core/keys.js";
import type { Lang } from "@azaadawaaz/schema";
import { useApp } from "../../data/context.js";
import { useI18n } from "../../i18n/index.js";
import { StoryBody, StoryHeader } from "../../components/StoryView.js";
import { StoryLangSwitch } from "../StoryPage.js";
import { errorText, useMod } from "./common.js";
import { PreviewError, openSubmission, previewMedia, type OpenedSubmission } from "./preview.js";
import { approve, decide, publisherX25519, PublisherKeyError } from "./actions.js";

export function Review() {
  const { id = "" } = useParams();
  const app = useApp();
  const { t, lang: uiLang } = useI18n();
  const nav = useNavigate();
  const { mod, api, sk } = useMod();
  const [opened, setOpened] = useState<OpenedSubmission>();
  const [error, setError] = useState<string>();
  const [lang, setLang] = useState<Lang>();
  const [mode, setMode] = useState<"none" | "approve" | "reject" | "changes">("none");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [progress, setProgress] = useState<Record<string, string>>({});

  useEffect(() => {
    let c = false;
    // Opening claims the submission for a while so two moderators don't review it at once (advisory).
    void api.claim(id).catch(() => {});
    openSubmission(api, id, mod.x25519).then(
      (o) => !c && setOpened(o),
      (e: unknown) => {
        if (c) return;
        if (e instanceof PreviewError)
          setError(t(`preview.error.${e.code}`) + (e.message !== e.code ? ` (${e.message})` : ""));
        else setError(errorText(e));
      },
    );
    return () => {
      c = true;
    };
  }, [api, id, mod.x25519, t]);

  const preview = useMemo(
    () =>
      opened
        ? previewMedia(api, opened, (sha, d, total) => setProgress((p) => ({ ...p, [sha]: `${d}/${total}` })))
        : undefined,
    [api, opened],
  );
  useEffect(() => () => preview?.dispose(), [preview]);

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!opened || !preview) return <p className="muted">{t("preview.decrypting")}</p>;

  const body = opened.body;
  const langs = storyLanguages(body.language);
  const shown = lang && langs.includes(lang) ? lang : langs.includes(uiLang) ? uiLang : langs[0]!;
  const decided = ["approved", "publishing", "published", "rejected", "unlisted"].includes(opened.detail.state);

  const act = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      if (mode === "approve") {
        if (!app.lists) throw new Error(t("banner.noLists"));
        const pk = await publisherX25519(app.lists, api);
        await approve(api, opened, sk, pk);
        setResult(t("preview.approved"));
      } else if (mode === "reject" || mode === "changes") {
        if (!text.trim()) return;
        await decide(api, opened, mod.signer, mode, text.trim());
        setResult(mode === "reject" ? t("preview.rejected") : t("preview.changesSent"));
      }
      setMode("none");
      setTimeout(() => nav("/moderate"), 1200);
    } catch (e) {
      setResult(e instanceof PublisherKeyError ? t(`preview.publisherKey.${e.reason}`) : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review" data-testid="review">
      <p>
        <Link to="/moderate">{t("mod.backToQueue")}</Link>
      </p>
      <div className="banner info small">
        {t("preview.notice")} · {t(`state.${opened.detail.state}`)} · {t("preview.contributor")}{" "}
        <span className="mono">{hexToNpub(opened.detail.contributor).slice(0, 16)}…</span>
        {body.version > 1 && <> · {t("preview.correction", { version: body.version })}</>}
      </div>
      {Object.keys(progress).length > 0 && (
        <p className="muted small">
          {t("preview.mediaProgress")} {Object.values(progress).join(" · ")}
        </p>
      )}
      <StoryLangSwitch langs={langs} value={shown} onChange={setLang} />
      <article className="story preview">
        <StoryHeader story={body} lang={shown} />
        <StoryBody story={body} lang={shown} preview={preview.media} />
        {body.tags.length > 0 && <p className="tags">{body.tags.map((x) => `#${x}`).join(" ")}</p>}
      </article>

      {!decided && (
        <div className="decision">
          <button type="button" onClick={() => setMode("approve")} disabled={busy}>
            {t("preview.approve")}
          </button>
          <button type="button" className="secondary" onClick={() => setMode("changes")} disabled={busy}>
            {t("preview.requestChanges")}
          </button>
          <button type="button" className="danger" onClick={() => setMode("reject")} disabled={busy}>
            {t("preview.reject")}
          </button>
        </div>
      )}
      {mode === "approve" && (
        <div className="banner warn">
          <p>{t("preview.approveConfirm")}</p>
          <button type="button" onClick={() => void act()} disabled={busy}>
            {busy ? t("common.working") : t("preview.approveSign")}
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setMode("none")}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {(mode === "reject" || mode === "changes") && (
        <div className="card-form">
          <label htmlFor="fb">{mode === "reject" ? t("preview.rejectReason") : t("preview.changesNotes")}</label>
          <textarea id="fb" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="small muted">{t("preview.feedbackPrivate")}</p>
          <button
            type="button"
            className={mode === "reject" ? "danger" : ""}
            onClick={() => void act()}
            disabled={busy || !text.trim()}
          >
            {busy ? t("common.working") : mode === "reject" ? t("preview.reject") : t("preview.requestChanges")}
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setMode("none")}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {result && (
        <p className="banner" role="status">
          {result}
        </p>
      )}
    </div>
  );
}
