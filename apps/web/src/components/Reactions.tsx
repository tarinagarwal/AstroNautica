import { useEffect, useMemo, useState } from "react";
import { countReactions, myReactions, reactionTemplate, REACTIONS, type Reaction } from "@core/social.js";
import type { StoryRef } from "@core/stories.js";
import type { Event, EventTemplate } from "nostr-tools/pure";
import { useI18n } from "../i18n/index.js";
import { useApp } from "../data/context.js";
import { getReaderKey, onReaderKeyChange } from "../lib/readerKey.js";
import { BackupPrompt } from "./BackupPrompt.js";

type Post = (t: EventTemplate) => Promise<{ event: Event; createdKey: boolean; accepted: number }>;

export function Reactions({ story, events, post }: { story: StoryRef; events: Event[]; post: Post }) {
  const { t, num } = useI18n();
  const app = useApp();
  const [me, setMe] = useState<string>();
  const [busy, setBusy] = useState<Reaction>();
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const load = () => void getReaderKey().then((k) => setMe(k?.pubkey));
    load();
    return onReaderKeyChange(load);
  }, []);

  const counts = useMemo(
    () => countReactions(events, story.address, app.lists ?? { muted: new Set() }, app.config.powDifficulty),
    [events, story.address, app.lists, app.config.powDifficulty],
  );
  const mine = useMemo(() => (me ? myReactions(events, story.address, me) : new Set<Reaction>()), [events, story.address, me]);

  const react = async (r: Reaction) => {
    if (mine.has(r) || busy) return;
    setBusy(r);
    setError(undefined);
    try {
      const res = await post(reactionTemplate({ story, reaction: r }));
      if (res.accepted === 0) setError(t("comments.notAccepted"));
      if (res.createdKey) setBackup(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="reactions" aria-label={t("reactions.title")} data-testid="reactions">
      <div className="reaction-row">
        {REACTIONS.map((r) => (
          <button
            key={r}
            type="button"
            className={"reaction" + (mine.has(r) ? " mine" : "")}
            aria-pressed={mine.has(r)}
            aria-label={r === "⭐" ? t("reactions.important") : t("reactions.react", { emoji: r })}
            title={r === "⭐" ? t("reactions.important") : undefined}
            disabled={busy !== undefined}
            onClick={() => void react(r)}
            data-testid={`reaction-${r}`}
          >
            <span aria-hidden="true">{r}</span> <span className="count">{num(counts[r])}</span>
            {r === "⭐" && <span className="small"> {t("reactions.important")}</span>}
          </button>
        ))}
      </div>
      {busy && <p className="muted small">{t("reactions.working")}</p>}
      {error && <p className="error small">{error}</p>}
      {backup && <BackupPrompt onClose={() => setBackup(false)} />}
    </section>
  );
}
