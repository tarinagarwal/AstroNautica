import type { Cover, FileRef, ImageItem } from "@azaadawaaz/schema";
import React, { useEffect, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View, Alert } from "react-native";
import Video from "react-native-video";
import type { ImageSize } from "../../data/media";
import { blurhashDataUri } from "../../util/blurhashImage";
import { useServices } from "../context";
import { useI18n } from "../i18n";
import { inlineText, parseMarkdown, type Inline, type MdBlock } from "../markdown/parse";
import { colors, fontFamily, space } from "../theme";
import { Button, Txt } from "./basic";

/** content:// authority of the verified media provider (AndroidManifest: ${applicationId}.media). */
export const MEDIA_AUTHORITY = "org.azaadawaaz.app.media";

export function hlsUri(ipfsPath: string): string {
  return `content://${MEDIA_AUTHORITY}/ipfs/${ipfsPath.replace(/^\/?ipfs\//, "")}`;
}

export function BlurhashView({ hash, aspect }: { hash?: string; aspect: number }) {
  const uri = hash ? blurhashDataUri(hash) : undefined;
  return (
    <View style={{ aspectRatio: aspect, backgroundColor: colors.code, borderRadius: 6, overflow: "hidden" }}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" blurRadius={2} /> : null}
    </View>
  );
}

/** An image shown only after its bytes were verified (by CID or SHA-256) and written to the cache. */
export function VerifiedImage({
  item,
  size = "960",
  aspect,
}: {
  item: Pick<ImageItem, "sha256" | "cid" | "variants" | "blurhash" | "width" | "height"> | Cover;
  size?: ImageSize;
  aspect?: number;
}) {
  const { media } = useServices();
  const { t } = useI18n();
  const [path, setPath] = useState<string>();
  const [failed, setFailed] = useState(false);
  const ratio = aspect ?? (item.width && item.height ? item.width / item.height : 16 / 9);
  useEffect(() => {
    let live = true;
    setPath(undefined);
    setFailed(false);
    media
      .image(item, size)
      .then((p) => live && setPath(p))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [media, item, size]);
  if (!path)
    return (
      <View>
        <BlurhashView hash={item.blurhash} aspect={ratio} />
        {failed ? (
          <Txt muted size={13} style={{ marginTop: space.xs }}>
            {t("media.unavailable")}
          </Txt>
        ) : null}
      </View>
    );
  return (
    <Image
      source={{ uri: `file://${path}` }}
      style={{ width: "100%", aspectRatio: ratio, borderRadius: 6 }}
      resizeMode="cover"
      accessibilityIgnoresInvertColors
    />
  );
}

export function LocalImage({ path, aspect = 4 / 3 }: { path: string; aspect?: number }) {
  return (
    <Image
      source={{ uri: `file://${path}` }}
      style={{ width: "100%", aspectRatio: aspect, borderRadius: 6 }}
      resizeMode="cover"
    />
  );
}

/**
 * Video: HLS through the in-app verified media provider (every block checked against its CID, gateways tried in
 * turn, all through Tor/DoH); if that fails, the MP4 fallback is downloaded and played only once its SHA-256 matches.
 */
export function VideoPlayer({
  hls,
  mp4,
  poster,
  offlinePath,
}: {
  hls: string;
  mp4: FileRef;
  poster?: FileRef;
  offlinePath?: string;
}) {
  const { media, gateways, net } = useServices();
  const { t } = useI18n();
  const [mode, setMode] = useState<"idle" | "hls" | "mp4-loading" | "mp4" | "error">(offlinePath ? "mp4" : "idle");
  const [file, setFile] = useState<string | undefined>(offlinePath);
  const [posterPath, setPosterPath] = useState<string>();
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (poster) media.file(poster).then(setPosterPath, () => undefined);
  }, [media, poster]);
  const fallback = () => {
    setMode("mp4-loading");
    media
      .video(mp4, (bytes, total) => setProgress(total > 0 ? bytes / total : 0))
      .then((p) => {
        setFile(p);
        setMode("mp4");
      })
      .catch(() => setMode("error"));
  };
  const start = () => {
    net.setMediaGateways(gateways.ipfsBases());
    setMode("hls");
  };
  if (mode === "idle")
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={t("video.play")} onPress={start}>
        <View
          style={{
            aspectRatio: 16 / 9,
            backgroundColor: "#000",
            borderRadius: 6,
            overflow: "hidden",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {posterPath ? (
            <Image source={{ uri: `file://${posterPath}` }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : null}
          <Text style={{ color: "#fff", fontSize: 48 }}>▶</Text>
        </View>
      </Pressable>
    );
  if (mode === "mp4-loading")
    return (
      <View
        style={{
          aspectRatio: 16 / 9,
          backgroundColor: "#111",
          borderRadius: 6,
          justifyContent: "center",
          padding: space.l,
        }}
      >
        <Txt style={{ color: "#fff" }}>{t("video.downloading", { percent: Math.round(progress * 100) })}</Txt>
      </View>
    );
  if (mode === "error")
    return (
      <View style={{ padding: space.m, backgroundColor: colors.badBg, borderRadius: 6 }}>
        <Txt>{t("video.failed")}</Txt>
        <Button small kind="secondary" title={t("common.retry")} onPress={start} />
      </View>
    );
  const source = mode === "hls" ? { uri: hlsUri(hls), type: "m3u8" as const } : { uri: `file://${file}` };
  return (
    <Video
      source={source}
      style={{ width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000", borderRadius: 6 }}
      controls
      resizeMode="contain"
      onError={() => (mode === "hls" ? fallback() : setMode("error"))}
    />
  );
}

function InlineText({ nodes, lang, onLink }: { nodes: Inline[]; lang: "en" | "hi"; onLink: (href: string) => void }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Text key={i}>{n.text}</Text>;
          case "br":
            return <Text key={i}>{"\n"}</Text>;
          case "code":
            return (
              <Text key={i} style={{ fontFamily: "monospace", backgroundColor: colors.code }}>
                {n.text}
              </Text>
            );
          case "strong":
            return (
              <Text key={i} style={{ fontWeight: "700" }}>
                <InlineText nodes={n.children} lang={lang} onLink={onLink} />
              </Text>
            );
          case "em":
            return (
              <Text key={i} style={{ fontStyle: "italic" }}>
                <InlineText nodes={n.children} lang={lang} onLink={onLink} />
              </Text>
            );
          case "link":
            return (
              <Text
                key={i}
                accessibilityRole="link"
                style={{ color: colors.link, textDecorationLine: "underline" }}
                onPress={() => onLink(n.href)}
              >
                <InlineText nodes={n.children} lang={lang} onLink={onLink} />
              </Text>
            );
        }
      })}
    </>
  );
}

function MdBlocks({ blocks, lang, onLink }: { blocks: MdBlock[]; lang: "en" | "hi"; onLink: (href: string) => void }) {
  const base = { fontFamily: fontFamily(lang), color: colors.text, fontSize: 17, lineHeight: 26 };
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "heading": {
            const size = [0, 26, 22, 19, 18, 17, 17][b.level] ?? 17;
            return (
              <Text
                key={i}
                accessibilityRole="header"
                style={[
                  base,
                  {
                    fontSize: size,
                    lineHeight: size * 1.35,
                    fontWeight: "700",
                    marginTop: space.m,
                    marginBottom: space.s,
                  },
                ]}
              >
                <InlineText nodes={b.children} lang={lang} onLink={onLink} />
              </Text>
            );
          }
          case "paragraph":
            return (
              <Text key={i} selectable style={[base, { marginBottom: space.m }]}>
                <InlineText nodes={b.children} lang={lang} onLink={onLink} />
              </Text>
            );
          case "quote":
            return (
              <View
                key={i}
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: colors.border,
                  paddingLeft: space.m,
                  marginBottom: space.m,
                }}
              >
                <MdBlocks blocks={b.children} lang={lang} onLink={onLink} />
              </View>
            );
          case "list":
            return (
              <View key={i} style={{ marginBottom: space.m }}>
                {b.items.map((item, j) => (
                  <View key={j} style={{ flexDirection: "row" }}>
                    <Text style={[base, { width: 28 }]}>{b.ordered ? `${b.start + j}.` : "•"}</Text>
                    <View style={{ flex: 1 }}>
                      <MdBlocks blocks={item} lang={lang} onLink={onLink} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case "code":
            return (
              <Text
                key={i}
                selectable
                style={{
                  fontFamily: "monospace",
                  backgroundColor: colors.code,
                  padding: space.s,
                  marginBottom: space.m,
                }}
              >
                {b.text}
              </Text>
            );
          case "hr":
            return <View key={i} style={{ height: 1, backgroundColor: colors.border, marginVertical: space.m }} />;
        }
      })}
    </>
  );
}

/** Markdown rendered as native text; links open only after the reader confirms (no automatic third-party requests). */
export function Markdown({ source, lang }: { source: string; lang: "en" | "hi" }) {
  const { t } = useI18n();
  const blocks = React.useMemo(() => parseMarkdown(source), [source]);
  const onLink = (href: string) =>
    Alert.alert(t("link.openTitle"), t("link.openBody", { url: href }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("link.open"), onPress: () => void Linking.openURL(href) },
    ]);
  return <MdBlocks blocks={blocks} lang={lang} onLink={onLink} />;
}

export { inlineText };
