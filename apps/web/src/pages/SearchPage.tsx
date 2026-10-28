import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { StoryRef } from "@core/stories.js";
import { useApp } from "../data/context.js";
import { useT } from "../i18n/index.js";
import { StoryCard } from "../components/StoryCard.js";

/** Client-side search over the titles, summaries and tags of loaded stories (no server sees the query). */
export function searchStories(stories: StoryRef[], query: string): StoryRef[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return stories.filter((s) => {
    const hay = [
      s.title,
      s.event.tags.find((t) => t[0] === "title-hi")?.[1] ?? "",
      s.summary,
      s.event.content,
      ...s.tags,
    ]
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export default function SearchPage() {
  const app = useApp();
  const t = useT();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const results = useMemo(() => searchStories(app.stories, q), [app.stories, q]);
  return (
    <div className="page">
      <h1>{t("nav.search")}</h1>
      <form role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="q" className="sr-only">
          {t("search.label")}
        </label>
        <input
          id="q"
          type="search"
          value={q}
          placeholder={t("search.placeholder")}
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
          autoFocus
        />
      </form>
      <p className="muted small">{t("search.scope", { count: app.stories.length })}</p>
      {q && results.length === 0 && <p className="muted">{t("search.none")}</p>}
      <div className="cards">
        {results.map((s) => (
          <StoryCard key={s.storyId} story={s} />
        ))}
      </div>
    </div>
  );
}
