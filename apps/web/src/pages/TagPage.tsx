import { useParams } from "react-router-dom";
import { useApp } from "../data/context.js";
import { useT } from "../i18n/index.js";
import { StoryCard } from "../components/StoryCard.js";

export default function TagPage() {
  const { tag = "" } = useParams();
  const app = useApp();
  const t = useT();
  const stories = app.stories.filter((s) => s.tags.some((x) => x.toLocaleLowerCase() === tag.toLocaleLowerCase()));
  return (
    <div className="page">
      <h1>{t("tag.title", { tag })}</h1>
      {stories.length === 0 && <p className="muted">{t("tag.empty")}</p>}
      <div className="cards">
        {stories.map((s) => (
          <StoryCard key={s.storyId} story={s} />
        ))}
      </div>
    </div>
  );
}
