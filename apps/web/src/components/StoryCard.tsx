import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { StoryRef } from "@core/stories.js";
import { useI18n } from "../i18n/index.js";
import { VerifiedImage, publishedImageLoader } from "./VerifiedImage.js";

/** Titles from the story event: `title` plus `title-hi` for bilingual stories. */
export function cardTitle(s: StoryRef, lang: "en" | "hi"): string {
  if (lang === "hi") return s.event.tags.find((t) => t[0] === "title-hi")?.[1] ?? s.title;
  return s.title;
}

/** Summary in the reader's language: bilingual events carry "en\n\nhi" as content. */
export function cardSummary(s: StoryRef, lang: "en" | "hi"): string {
  if (s.language === "both" && lang === "hi") {
    const parts = s.event.content.split("\n\n");
    if (parts.length >= 2) return parts.slice(1).join("\n\n");
  }
  return s.summary;
}

export function StoryCard({ story, featured }: { story: StoryRef; featured?: boolean }) {
  const { lang, t, date } = useI18n();
  const load = useMemo(() => (story.coverCid ? publishedImageLoader({ cid: story.coverCid }) : null), [story.coverCid]);
  const title = cardTitle(story, lang);
  const summary = cardSummary(story, lang);
  return (
    <article className={"card" + (featured ? " featured" : "")} data-testid="story-card">
      <Link to={`/story/${story.storyId}`} className="card-link">
        {load && <VerifiedImage load={load} alt="" className="card-cover" width={16} height={9} />}
        <div className="card-body">
          {featured && <span className="pill">{t("home.featured")}</span>}
          <h3 lang={story.language === "hi" ? "hi" : undefined}>{title}</h3>
          {summary && <p className="summary">{summary}</p>}
          <p className="meta">{t("story.publishedOn", { date: date(story.publishedAt) })}</p>
        </div>
      </Link>
      {story.tags.length > 0 && (
        <p className="tags">
          {story.tags.slice(0, 4).map((tag) => (
            <Link key={tag} to={`/tag/${encodeURIComponent(tag)}`} className="tag">
              #{tag}
            </Link>
          ))}
        </p>
      )}
    </article>
  );
}
