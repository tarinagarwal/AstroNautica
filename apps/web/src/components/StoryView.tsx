import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ApprovalBlock, ApprovalBody, Block, ImageItem, Lang, Manifest, VideoBlock } from "@azaadawaaz/schema";
import { pickText } from "@core/i18n.js";
import type { StoryRef } from "@core/stories.js";
import { useI18n, useT } from "../i18n/index.js";
import { useApp } from "../data/context.js";
import { renderMarkdown } from "../lib/markdown.js";
import { VerifiedImage, publishedImageLoader, type ImageLoader } from "./VerifiedImage.js";
import { VideoPlayer } from "./VideoPlayer.js";
import { cardSummary, cardTitle } from "./StoryCard.js";

/** Resolves original media (by SHA-256) to object URLs, for previews of unpublished submissions. */
export interface PreviewMedia {
  url(sha256: string, kind: "image" | "video"): Promise<string>;
}

export function Markdown({ text, lang }: { text: string; lang?: Lang }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // Safe: markdown-it with html disabled escapes all HTML; links are restricted to http(s)/mailto (lib/markdown.ts).
  return <div className="md" lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ImageGallery({
  items,
  lang,
  preview,
}: {
  items: (ImageItem | { sha256: string; caption?: ImageItem["caption"] })[];
  lang: Lang;
  preview?: PreviewMedia;
}) {
  const t = useT();
  return (
    <div className={items.length > 1 ? "gallery" : "single-image"} data-testid="image-block">
      {items.map((it, i) => (
        <GalleryItem key={it.sha256 + i} item={it} lang={lang} preview={preview} index={i} total={items.length} t={t} />
      ))}
    </div>
  );
}

function GalleryItem({
  item,
  lang,
  preview,
  index,
  total,
  t,
}: {
  item: ImageItem | { sha256: string; caption?: ImageItem["caption"] };
  lang: Lang;
  preview?: PreviewMedia;
  index: number;
  total: number;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const published = "cid" in item ? (item as ImageItem) : undefined;
  const load: ImageLoader = useMemo(
    () => (published ? publishedImageLoader(published) : () => preview!.url(item.sha256, "image")),
    [published, preview, item.sha256],
  );
  const caption = pickText(item.caption, lang);
  return (
    <figure className="figure">
      <VerifiedImage
        load={load}
        width={published?.width}
        height={published?.height}
        blurhash={published?.blurhash}
        alt={caption || t("image.alt", { n: index + 1, total })}
      />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function PreviewVideo({
  block,
  lang,
  preview,
}: {
  block: { source: { sha256: string } };
  lang: Lang;
  preview: PreviewMedia;
}) {
  const t = useT();
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState(false);
  useEffect(() => {
    let c = false;
    preview.url(block.source.sha256, "video").then(
      (u) => !c && setUrl(u),
      () => !c && setErr(true),
    );
    return () => {
      c = true;
    };
  }, [block.source.sha256, preview]);
  return (
    <figure className="video" data-testid="video-block" lang={lang}>
      {url ? (
        <video src={url} controls playsInline />
      ) : (
        <p className="muted">{err ? t("media.unavailable") : t("preview.decrypting")}</p>
      )}
    </figure>
  );
}

export function EmbedStory({ storyId, version }: { storyId: string; version?: number }) {
  const app = useApp();
  const { t, lang } = useI18n();
  const [ref, setRef] = useState<StoryRef | null | undefined>(undefined);
  useEffect(() => {
    let c = false;
    app.getStory(storyId).then(
      (r) => !c && setRef(r && !r.unlisted ? r.ref : null),
      () => !c && setRef(null),
    );
    return () => {
      c = true;
    };
  }, [app, storyId]);
  return (
    <aside className="embed" data-testid="embed-block">
      <span className="pill">{t("embed.label")}</span>
      {ref === undefined && <p className="muted">{t("common.loading")}</p>}
      {ref === null && <p className="muted">{t("embed.unavailable")}</p>}
      {ref && (
        <Link to={`/story/${ref.storyId}`}>
          <strong>{cardTitle(ref, lang)}</strong>
          <span className="summary">{cardSummary(ref, lang)}</span>
          {version !== undefined && version !== ref.version && (
            <span className="muted small">{t("embed.versionNote", { version, latest: ref.version })}</span>
          )}
        </Link>
      )}
    </aside>
  );
}

function BlockView({ block, lang, preview }: { block: Block | ApprovalBlock; lang: Lang; preview?: PreviewMedia }) {
  switch (block.type) {
    case "text":
      return <Markdown text={pickText(block.markdown, lang)} lang={lang} />;
    case "image":
      return <ImageGallery items={block.items} lang={lang} preview={preview} />;
    case "video": {
      const title = pickText(block.title, lang);
      const description = pickText(block.description, lang);
      return (
        <section className="video-block">
          {title && <h3>{title}</h3>}
          {preview || !("hls" in block) ? (
            <PreviewVideo block={block} lang={lang} preview={preview!} />
          ) : (
            <VideoPlayer block={block as VideoBlock} title={title} />
          )}
          {description && <p className="video-desc">{description}</p>}
        </section>
      );
    }
    case "embed-story":
      return <EmbedStory storyId={block.storyId} version={block.version} />;
  }
}

/** Renders a published manifest or (with `preview`) a decrypted approval body. */
export function StoryBody({
  story,
  lang,
  preview,
}: {
  story: Manifest | ApprovalBody;
  lang: Lang;
  preview?: PreviewMedia;
}) {
  return (
    <div className="story-body" lang={lang}>
      {story.blocks.map((b, i) => (
        <BlockView key={i} block={b} lang={lang} preview={preview} />
      ))}
    </div>
  );
}

export function StoryHeader({
  story,
  lang,
  publishedAt,
}: {
  story: Manifest | ApprovalBody;
  lang: Lang;
  publishedAt?: string;
}) {
  const { t, date } = useI18n();
  const location = pickText(story.location, lang);
  const cover = "cid" in (story.cover ?? {}) ? (story as Manifest).cover : undefined;
  const coverLoad = useMemo(() => (cover ? publishedImageLoader(cover) : undefined), [cover]);
  return (
    <header className="story-header" lang={lang}>
      <h1>{pickText(story.title, lang)}</h1>
      <p className="lede">{pickText(story.summary, lang)}</p>
      <p className="meta">
        {t("story.by", { name: story.contributor.displayName || t("story.defaultContributor") })}
        {publishedAt && <> · {t("story.publishedOn", { date: date(publishedAt) })}</>}
        {location && <> · {location}</>}
      </p>
      {cover && coverLoad && (
        <VerifiedImage
          load={coverLoad}
          width={cover.width}
          height={cover.height}
          blurhash={cover.blurhash}
          alt=""
          className="cover"
        />
      )}
    </header>
  );
}
