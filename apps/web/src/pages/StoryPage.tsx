import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Lang } from "@azaadawaaz/schema";
import { defaultStoryLang, pickText, storyLanguages } from "@core/i18n.js";
import type { StoryRef } from "@core/stories.js";
import { useApp } from "../data/context.js";
import { useI18n } from "../i18n/index.js";
import type { LoadedManifest } from "../data/appData.js";
import { useSocial } from "../data/useSocial.js";
import { StoryBody, StoryHeader } from "../components/StoryView.js";
import { VerifyPanel } from "../components/VerifyPanel.js";
import { ShareButton } from "../components/ShareButton.js";
import { Reactions } from "../components/Reactions.js";
import { Comments } from "../components/Comments.js";
import { useSession } from "../data/session.js";
import { ModeratorStoryTools } from "../components/ModeratorStoryTools.js";

export function StoryLangSwitch({ langs, value, onChange }: { langs: Lang[]; value: Lang; onChange: (l: Lang) => void }) {
  const { t } = useI18n();
  if (langs.length < 2) return null;
  return (
    <div className="lang-switch story-lang" role="group" aria-label={t("story.readIn")} data-testid="story-lang">
      <span className="muted small">{t("story.readIn")}</span>
      {langs.map((l) => (
        <button key={l} type="button" className={l === value ? "on" : ""} aria-pressed={l === value} onClick={() => onChange(l)}>
          {t(`lang.${l}`)}
        </button>
      ))}
    </div>
  );
}

function Loaded({ story }: { story: StoryRef }) {
  const app = useApp();
  const { t, lang: uiLang, date } = useI18n();
  const { moderator } = useSession();
  const [m, setM] = useState<LoadedManifest | null | undefined>(undefined);
  const [storyLang, setStoryLang] = useState<Lang>();
  const [showVerify, setShowVerify] = useState(false);
  const social = useSocial(app, story);

  useEffect(() => {
    let c = false;
    setM(undefined);
    app.loadManifest(story).then(
      (x) => !c && setM(x),
      () => !c && setM(null),
    );
    return () => {
      c = true;
    };
  }, [app, story]);

  if (m === undefined) return <p className="muted pad">{t("story.loading")}</p>;
  if (m === null || !m.check.ok || !m.check.manifest) {
    return (
      <div className="page">
        <p className="error" role="alert" data-testid="story-error">
          {m === null ? t("error.allSourcesFailed") : t("verify.failed")}
        </p>
        {m === null && (
          <p>
            <Link to="/reach">{t("nav.reach")}</Link>
          </p>
        )}
        <VerifyPanel story={story} />
      </div>
    );
  }
  const manifest = m.check.manifest;
  const langs = storyLanguages(manifest.language);
  const lang = storyLang && langs.includes(storyLang) ? storyLang : defaultStoryLang(manifest.language, uiLang);
  const title = pickText(manifest.title, lang);

  return (
    <article className="page story" data-testid="story">
      <StoryLangSwitch langs={langs} value={lang} onChange={setStoryLang} />
      <StoryHeader story={manifest} lang={lang} publishedAt={manifest.publishedAt} />
      {manifest.supersedes && (
        <p className="corrected" data-testid="corrected">
          {t("story.correctedOn", { date: date(manifest.publishedAt) })} ·{" "}
          <Link to={`/story/${manifest.id}/version/${manifest.supersedes}`}>{t("story.previousVersion")}</Link>
        </p>
      )}
      <div className="actions">
        <ShareButton title={title} />
        <button type="button" className={showVerify ? "on" : ""} aria-expanded={showVerify} onClick={() => setShowVerify((x) => !x)} data-testid="verify-button">
          {t("verify.button")}
        </button>
      </div>
      {showVerify && <VerifyPanel story={story} />}
      <StoryBody story={manifest} lang={lang} />
      {manifest.tags.length > 0 && (
        <p className="tags">
          {manifest.tags.map((tag) => (
            <Link key={tag} to={`/tag/${encodeURIComponent(tag)}`} className="tag">
              #{tag}
            </Link>
          ))}
        </p>
      )}
      {moderator && <ModeratorStoryTools story={story} />}
      <Reactions story={story} events={social.events} post={social.post} />
      <Comments story={story} events={social.events} loaded={social.loaded} post={social.post} />
    </article>
  );
}

export default function StoryPage() {
  const { id = "" } = useParams();
  const app = useApp();
  const { t } = useI18n();
  const [found, setFound] = useState<{ ref: StoryRef; unlisted: boolean } | null | undefined>(undefined);
  const ready = app.listsStatus !== "loading" && !!app.lists;
  const known = app.stories.find((s) => s.storyId === id);

  useEffect(() => {
    if (!ready) return;
    let c = false;
    app.getStory(id).then(
      (r) => !c && setFound(r ?? null),
      () => !c && setFound(null),
    );
    return () => {
      c = true;
    };
    // `known` changes when a newer version arrives from relays
  }, [app, id, ready, known?.eventId]);

  if (app.listsStatus === "none") return <p className="pad">{t("banner.noLists")}</p>;
  if (found === undefined) return <p className="muted pad">{t("story.loading")}</p>;
  if (found === null) return <p className="pad" data-testid="story-not-found">{t("story.notFound")}</p>;
  if (found.unlisted) {
    return (
      <div className="page">
        <p className="banner warn" role="status" data-testid="story-unlisted">
          {t("story.unlistedNotice")}
        </p>
      </div>
    );
  }
  return <Loaded key={found.ref.eventId} story={found.ref} />;
}
