import { useState } from "react";
import type { StoryRef } from "@core/stories.js";
import { useApp } from "../data/context.js";
import { useSession } from "../data/session.js";
import { useT } from "../i18n/index.js";
import { setFeatured, unlistStory } from "../data/moderation.js";
import { Api } from "../lib/api.js";

/** Unlist and feature controls shown to a logged-in moderator on a story page. */
export function ModeratorStoryTools({ story }: { story: StoryRef }) {
  const app = useApp();
  const t = useT();
  const { moderator } = useSession();
  const [msg, setMsg] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  if (!moderator?.signer.secretKey) return null;
  const sk = moderator.signer.secretKey;
  const me = moderator.signer.pubkey;
  const featured = app.lists?.featured.has(story.storyId) ?? false;
  const api = app.config.apiUrl ? new Api(app.config.apiUrl, moderator.signer) : null;

  const unlist = async () => {
    setConfirming(false);
    const r = await unlistStory(app, api, sk, me, story.storyId);
    const ok = r.relays.filter((x) => x.ok).length;
    setMsg(
      t("moderate.unlisted", { ok, total: r.relays.length }) +
        (r.auditError ? " " + t("moderate.auditFailed", { error: r.auditError }) : ""),
    );
  };
  const feature = async () => {
    const r = await setFeatured(app, sk, me, story.storyId, !featured);
    setMsg(t("moderate.listPublished", { ok: r.relays.filter((x) => x.ok).length, total: r.relays.length }));
  };

  return (
    <section className="mod-tools" aria-label={t("moderate.tools")}>
      <h2>{t("moderate.tools")}</h2>
      <button type="button" className="secondary" onClick={() => void feature()}>
        {featured ? t("moderate.unfeature") : t("moderate.feature")}
      </button>{" "}
      {!confirming && (
        <button type="button" className="danger" onClick={() => setConfirming(true)}>
          {t("moderate.unlist")}
        </button>
      )}
      {confirming && (
        <div className="banner warn">
          <p>{t("moderate.unlistHonest")}</p>
          <button type="button" className="danger" onClick={() => void unlist()}>
            {t("moderate.unlistConfirm")}
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}
