import { useApp } from "../data/context.js";
import { useT } from "../i18n/index.js";
import { StoryCard } from "../components/StoryCard.js";

export function Home() {
  const app = useApp();
  const t = useT();
  const featured = app.stories.filter((s) => app.lists?.featured.has(s.storyId));
  const latest = app.stories;
  return (
    <div className="page">
      {featured.length > 0 && (
        <section aria-labelledby="featured-h">
          <h2 id="featured-h">{t("home.featured")}</h2>
          <div className="cards">
            {featured.map((s) => (
              <StoryCard key={s.storyId} story={s} featured />
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="latest-h">
        <h2 id="latest-h">{t("home.latest")}</h2>
        {!app.storiesLoaded && app.listsStatus !== "none" && <p className="muted">{t("common.loading")}</p>}
        {app.storiesLoaded && latest.length === 0 && <p className="muted">{t("home.empty")}</p>}
        <div className="cards">
          {latest.map((s) => (
            <StoryCard key={s.storyId} story={s} />
          ))}
        </div>
      </section>
    </div>
  );
}
