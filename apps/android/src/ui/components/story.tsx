import { pickText, storyLanguages, type StoryRef } from "@azaadawaaz/core";
import type { Block, Lang, Manifest } from "@azaadawaaz/schema";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useServices } from "../context";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { colors, space } from "../theme";
import { Badge, Card, Choice, Row, Txt } from "./basic";
import { Markdown, VerifiedImage, VideoPlayer } from "./media";

export function StoryCard({ story, onPress }: { story: StoryRef; onPress: () => void }) {
  const { lang, date } = useI18n();
  const hiTitle = story.event.tags.find((t) => t[0] === "title-hi")?.[1];
  const title = lang === "hi" && hiTitle ? hiTitle : story.title;
  return (
    <Card onPress={onPress}>
      <Txt bold size={18} lang={lang === "hi" && hiTitle ? "hi" : story.language === "hi" ? "hi" : "en"}>
        {title}
      </Txt>
      {story.summary ? (
        <Txt muted numberOfLines={3} style={{ marginTop: space.xs }}>
          {story.summary}
        </Txt>
      ) : null}
      <Row style={{ marginTop: space.s }}>
        <Txt muted size={13}>
          {date(story.publishedAt)}
        </Txt>
        {story.tags.slice(0, 3).map((tag) => (
          <Badge key={tag} label={`#${tag}`} tone="neutral" />
        ))}
      </Row>
    </Card>
  );
}

function EmbeddedStory({ storyId, version }: { storyId: string; version?: number }) {
  const { app } = useServices();
  const { t } = useI18n();
  const nav = useNav();
  const [ref, setRef] = useState<StoryRef | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    app.getStory(storyId).then(
      (r) => live && setRef(r?.ref ?? null),
      () => live && setRef(null),
    );
    return () => {
      live = false;
    };
  }, [app, storyId]);
  return (
    <Card
      onPress={ref ? () => nav.push({ name: "story", storyId }) : undefined}
      style={{ borderColor: colors.primary }}
    >
      <Txt muted size={13}>
        {t("embed.label")}
        {version ? ` · ${t("story.version", { version })}` : ""}
      </Txt>
      <Txt bold>{ref === undefined ? t("common.loading") : ref ? ref.title : t("embed.notFound")}</Txt>
    </Card>
  );
}

function BlockView({ block, lang, offline }: { block: Block; lang: Lang; offline?: Map<string, string> }) {
  switch (block.type) {
    case "text":
      return (
        <Markdown
          source={pickText(block.markdown, lang)}
          lang={block.markdown[lang] ? lang : block.markdown.en ? "en" : "hi"}
        />
      );
    case "image":
      return (
        <View style={{ marginBottom: space.l }}>
          {block.items.length > 1 ? (
            <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator>
              {block.items.map((item) => (
                <View key={item.sha256} style={{ width: 320, marginRight: space.s }}>
                  <VerifiedImage item={item} />
                  {item.caption ? (
                    <Txt muted size={14} style={{ marginTop: space.xs }}>
                      {pickText(item.caption, lang)}
                    </Txt>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          ) : (
            block.items.map((item) => (
              <View key={item.sha256}>
                <VerifiedImage item={item} />
                {item.caption ? (
                  <Txt muted size={14} style={{ marginTop: space.xs }}>
                    {pickText(item.caption, lang)}
                  </Txt>
                ) : null}
              </View>
            ))
          )}
        </View>
      );
    case "video":
      return (
        <View style={{ marginBottom: space.l }}>
          {block.title ? <Txt bold>{pickText(block.title, lang)}</Txt> : null}
          <VideoPlayer
            hls={block.hls}
            mp4={block.mp4}
            poster={block.poster}
            offlinePath={offline?.get(block.mp4.sha256)}
          />
          {block.description ? (
            <Txt muted size={14} style={{ marginTop: space.xs }}>
              {pickText(block.description, lang)}
            </Txt>
          ) : null}
        </View>
      );
    case "embed-story":
      return <EmbeddedStory storyId={block.storyId} version={block.version} />;
  }
}

/** Renders a verified manifest: language switch for bilingual stories, then every block in order. */
export function StoryView({ manifest, offline }: { manifest: Manifest; offline?: Map<string, string> }) {
  const { lang: ui, t, date } = useI18n();
  const langs = storyLanguages(manifest.language);
  const [lang, setLang] = useState<Lang>(manifest.language === "both" ? ui : (manifest.language as Lang));
  return (
    <View>
      {langs.length > 1 ? (
        <Choice
          value={lang}
          onChange={setLang}
          options={langs.map((l) => ({ value: l, label: `${t("story.readIn")} ${t(`lang.${l}`)}` }))}
        />
      ) : null}
      <Txt bold size={26} lang={lang} style={{ lineHeight: 34 }}>
        {pickText(manifest.title, lang)}
      </Txt>
      <Txt muted size={14} style={{ marginVertical: space.s }}>
        {t("story.by", { name: manifest.contributor.displayName })} ·{" "}
        {t("story.publishedOn", { date: date(manifest.publishedAt) })}
        {manifest.location ? ` · ${pickText(manifest.location, lang)}` : ""}
      </Txt>
      {manifest.version > 1 ? (
        <Badge tone="warn" label={t("story.correctedOn", { date: date(manifest.publishedAt) })} />
      ) : null}
      {manifest.cover ? (
        <View style={{ marginVertical: space.m }}>
          <VerifiedImage item={manifest.cover} />
        </View>
      ) : null}
      <Txt size={17} lang={lang} style={{ fontStyle: "italic", marginBottom: space.l }}>
        {pickText(manifest.summary, lang)}
      </Txt>
      {manifest.blocks.map((b, i) => (
        <BlockView key={i} block={b} lang={lang} offline={offline} />
      ))}
      {manifest.tags.length ? (
        <Row style={{ marginTop: space.m }}>
          {manifest.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </Row>
      ) : null}
    </View>
  );
}

function TagChip({ tag }: { tag: string }) {
  const nav = useNav();
  return (
    <Pressable accessibilityRole="link" onPress={() => nav.push({ name: "tag", tag })}>
      <Badge label={`#${tag}`} tone="neutral" />
    </Pressable>
  );
}
