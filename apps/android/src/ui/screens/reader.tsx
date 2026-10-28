import type { StoryRef } from "@azaadawaaz/core";
import React, { useEffect, useState } from "react";
import { Alert, Linking, View } from "react-native";
import { setFeatured, unlistStory } from "../../moderator/actions";
import { signerFromSecret } from "../../api/nip98";
import { useObservable, useServices } from "../context";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { space } from "../theme";
import { Badge, Button, Card, Field, Loading, Notice, Row, Screen, Section, Txt } from "../components/basic";
import { Comments, Reactions } from "../components/social";
import { StoryCard, StoryView } from "../components/story";
import { VerifyPanel } from "../components/verify";
import type { LoadedManifest } from "../../data/appData";

function NetBanner() {
  const { net, app } = useServices();
  const { t } = useI18n();
  const nav = useNav();
  useObservable(net);
  if (net.settings.torEnabled && net.tor.state !== "on")
    return <Notice>{t("tor.connecting", { percent: net.tor.bootstrap })}</Notice>;
  if (net.settings.autoEnabled && net.tor.state === "on") return <Notice tone="ok">{t("tor.autoOn")}</Notice>;
  if (app.relaysUnreachable && !net.settings.torEnabled)
    return (
      <Notice tone="bad">
        <Txt>{t("error.allSourcesFailed")}</Txt>
        <Row>
          <Button small title={t("tor.useTor")} onPress={() => void net.setTor(true)} />
          <Button small kind="secondary" title={t("nav.reach")} onPress={() => nav.push({ name: "reach" })} />
        </Row>
      </Notice>
    );
  return null;
}

export function HomeScreen() {
  const { app } = useServices();
  const { t } = useI18n();
  const nav = useNav();
  useObservable(app);
  const featured = app.featured();
  const open = (s: StoryRef) => nav.push({ name: "story", storyId: s.storyId });
  return (
    <Screen
      title={t("app.name")}
      right={<Button small kind="link" title={t("nav.search")} onPress={() => nav.push({ name: "search" })} />}
    >
      <NetBanner />
      {app.listsStatus === "none" ? (
        <Notice tone="bad">
          <Txt bold>{t("banner.noLists")}</Txt>
          <Txt>{t("banner.noListsHelp")}</Txt>
        </Notice>
      ) : null}
      {featured.length ? (
        <Section title={t("home.featured")}>
          {featured.map((s) => (
            <StoryCard key={s.storyId} story={s} onPress={() => open(s)} />
          ))}
        </Section>
      ) : null}
      <Section title={t("home.latest")}>
        {!app.storiesLoaded ? <Loading label={t("common.loading")} /> : null}
        {app.storiesLoaded && app.stories.length === 0 ? <Txt muted>{t("home.empty")}</Txt> : null}
        {app.stories.map((s) => (
          <StoryCard key={s.storyId} story={s} onPress={() => open(s)} />
        ))}
      </Section>
      <Button kind="secondary" title={t("common.refresh")} onPress={() => void app.refresh()} />
    </Screen>
  );
}

export function TagScreen({ tag }: { tag: string }) {
  const { app } = useServices();
  const nav = useNav();
  useObservable(app);
  return (
    <Screen title={`#${tag}`}>
      {app.byTag(tag).map((s) => (
        <StoryCard key={s.storyId} story={s} onPress={() => nav.push({ name: "story", storyId: s.storyId })} />
      ))}
    </Screen>
  );
}

export function SearchScreen() {
  const { app } = useServices();
  const { t } = useI18n();
  const nav = useNav();
  const [q, setQ] = useState("");
  const results = app.search(q);
  return (
    <Screen title={t("nav.search")}>
      <Field label={t("search.label")} value={q} onChangeText={setQ} autoFocus returnKeyType="search" />
      {q && results.length === 0 ? <Txt muted>{t("search.none")}</Txt> : null}
      {results.map((s) => (
        <StoryCard key={s.storyId} story={s} onPress={() => nav.push({ name: "story", storyId: s.storyId })} />
      ))}
    </Screen>
  );
}

type Loaded = { ref: StoryRef; unlisted: boolean; manifest: LoadedManifest; offline?: Map<string, string> };

export function StoryScreen({ storyId, offline }: { storyId: string; offline?: boolean }) {
  const services = useServices();
  const { app, offline: saved, keys } = services;
  const { t } = useI18n();
  const nav = useNav();
  const [state, setState] = useState<Loaded | "loading" | "notfound" | { error: string }>("loading");
  const [showVerify, setShowVerify] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useObservable(app);

  useEffect(() => {
    let live = true;
    (async () => {
      setState("loading");
      if (!app.lists) return setState("notfound");
      if (offline || (await saved.isSaved(storyId))) {
        try {
          const o = await saved.open(storyId, app.lists);
          const entry = (await saved.list()).find((e) => e.storyId === storyId);
          const map = new Map<string, string>();
          for (const sha of entry?.files ?? []) {
            const p = await saved.lookup(sha);
            if (p) map.set(sha, p);
          }
          if (live && o.check.ok)
            return setState({
              ref: o.ref,
              unlisted: app.lists.unlisted.has(storyId),
              manifest: { check: o.check, bytes: o.manifestBytes, fromCache: true },
              offline: map,
            });
        } catch {
          // fall back to the network
        }
      }
      const found = await app.getStory(storyId);
      if (!found) return live && setState("notfound");
      const manifest = await app.loadManifest(found.ref);
      if (live) setState({ ...found, manifest });
    })().catch((e) => live && setState({ error: e instanceof Error ? e.message : String(e) }));
    void saved.isSaved(storyId).then((v) => live && setIsSaved(v));
    return () => {
      live = false;
    };
  }, [app, saved, storyId, offline]);

  if (state === "loading")
    return (
      <Screen title={t("story.loading")}>
        <Loading label={t("story.loading")} />
      </Screen>
    );
  if (state === "notfound")
    return (
      <Screen title={t("app.name")}>
        <Notice tone="bad">{t("story.notFound")}</Notice>
      </Screen>
    );
  if ("error" in state)
    return (
      <Screen title={t("app.name")}>
        <Notice tone="bad">{t("error.allSourcesFailed")}</Notice>
        <Txt muted size={13}>
          {state.error}
        </Txt>
      </Screen>
    );
  const { ref, manifest } = state;
  const m = manifest.check.manifest;
  const mod = keys.loaded ? keys.moderator() : undefined;
  const canUnlist = !!mod && !!app.lists?.activeModerators.has(mod.keys.pubkey) && !state.unlisted;

  const save = async () => {
    if (!m) return;
    setSaving(true);
    try {
      await saved.save({
        ref,
        manifest: m,
        manifestBytes: manifest.bytes,
        storageEvents: await app.storageReceiptEvents(ref.storyId, ref.version),
        includeVideo: true,
        fetchFile: async (sha, info) => {
          if (info.kind === "video") return services.media.video({ sha256: sha, cid: info.cid! });
          return services.media.original({ sha256: sha, cid: info.cid });
        },
      });
      setIsSaved(true);
    } catch (e) {
      Alert.alert(t("common.error"), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const unlist = () =>
    Alert.alert(t("moderate.unlistTitle"), t("moderate.unlistBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("moderate.unlist"),
        style: "destructive",
        onPress: () =>
          void unlistStory(
            app,
            services.api().withSigner(signerFromSecret(mod!.keys.secretKey)),
            mod!.keys.secretKey,
            mod!.keys.pubkey,
            ref.storyId,
          ).then(
            (r) =>
              Alert.alert(
                t("moderate.done"),
                r.auditError ? t("moderate.auditPending", { error: r.auditError }) : undefined,
              ),
            (e) => Alert.alert(t("common.error"), String(e)),
          ),
      },
    ]);

  return (
    <Screen title={ref.title}>
      {state.unlisted ? <Notice>{t("story.unlistedNotice")}</Notice> : null}
      {!manifest.check.ok ? (
        <Notice tone="bad">
          <Txt bold>{t("verify.failed")}</Txt>
          {manifest.check.errors.map((e) => (
            <Txt key={e} size={13}>
              {e}
            </Txt>
          ))}
        </Notice>
      ) : null}
      {m && manifest.check.ok ? <StoryView manifest={m} offline={state.offline} /> : null}
      <Row style={{ marginVertical: space.m }}>
        <Button
          kind="secondary"
          small
          title={showVerify ? t("common.close") : t("verify.button")}
          onPress={() => setShowVerify((v) => !v)}
        />
        <Button
          kind="secondary"
          small
          title={t("story.share")}
          onPress={() => nav.push({ name: "share", storyId: ref.storyId })}
        />
        {isSaved ? (
          <Badge tone="ok" label={t("offline.saved")} />
        ) : (
          <Button kind="secondary" small busy={saving} title={t("offline.save")} onPress={() => void save()} />
        )}
        {canUnlist ? (
          <Button
            kind="secondary"
            small
            title={app.lists?.featured.has(ref.storyId) ? t("moderate.unfeature") : t("moderate.feature")}
            onPress={() =>
              void setFeatured(
                app,
                mod!.keys.secretKey,
                mod!.keys.pubkey,
                ref.storyId,
                !app.lists?.featured.has(ref.storyId),
              ).then(
                () => Alert.alert(t("moderate.done")),
                (e) => Alert.alert(t("common.error"), String(e)),
              )
            }
          />
        ) : null}
        {canUnlist ? <Button kind="danger" small title={t("moderate.unlist")} onPress={unlist} /> : null}
      </Row>
      {showVerify ? <VerifyPanel story={ref} /> : null}
      {manifest.check.ok ? (
        <>
          <Reactions story={ref} />
          <Comments story={ref} />
        </>
      ) : null}
    </Screen>
  );
}

export function MenuScreen() {
  const { t } = useI18n();
  const nav = useNav();
  const items: { label: string; go: () => void }[] = [
    { label: t("nav.home"), go: () => nav.reset() },
    { label: t("nav.search"), go: () => nav.push({ name: "search" }) },
    { label: t("nav.saved"), go: () => nav.push({ name: "saved" }) },
    { label: t("nav.receive"), go: () => nav.push({ name: "receive" }) },
    { label: t("nav.reach"), go: () => nav.push({ name: "reach" }) },
    { label: t("nav.contribute"), go: () => nav.push({ name: "contribute" }) },
    { label: t("nav.moderate"), go: () => nav.push({ name: "moderate" }) },
    { label: t("nav.settings"), go: () => nav.push({ name: "settings" }) },
    { label: t("nav.about"), go: () => nav.push({ name: "about" }) },
  ];
  return (
    <Screen title={t("nav.menu")}>
      {items.map((i) => (
        <Card key={i.label} onPress={i.go}>
          <Txt bold>{i.label}</Txt>
        </Card>
      ))}
    </Screen>
  );
}

export function AboutScreen() {
  const { t } = useI18n();
  return (
    <Screen title={t("about.title")}>
      <Txt style={{ marginBottom: space.m }}>{t("about.p1")}</Txt>
      <Txt style={{ marginBottom: space.m }}>{t("about.p2")}</Txt>
      <Section title={t("about.verifyTitle")}>
        <Txt>{t("about.verify")}</Txt>
      </Section>
      <Section title={t("about.privacyTitle")}>
        <Txt>{t("about.privacy")}</Txt>
      </Section>
    </Screen>
  );
}

/** "How to reach us" (spec §10): every door from the signed lists, in simple English and Hindi. */
export function ReachScreen() {
  const { app, config, net } = useServices();
  const { t } = useI18n();
  useObservable(app);
  useObservable(net);
  const lists = app.lists;
  const androidRelease = lists?.releases
    .filter((r) => r.platform === "android")
    .sort((a, b) => b.versionCode - a.versionCode)[0];
  const webRelease = lists?.releases
    .filter((r) => r.platform === "web")
    .sort((a, b) => b.versionCode - a.versionCode)[0];
  const openUrl = (u: string) =>
    Alert.alert(t("link.openTitle"), t("link.openBody", { url: u }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("link.open"), onPress: () => void Linking.openURL(u) },
    ]);
  return (
    <Screen title={t("nav.reach")}>
      <Txt style={{ marginBottom: space.l }}>{t("reach.intro")}</Txt>
      <Section title={t("reach.app")}>
        <Txt>{t("reach.appHelp")}</Txt>
        <Button
          kind={net.settings.torEnabled ? "secondary" : "primary"}
          title={net.settings.torEnabled ? t("tor.turnOff") : t("tor.useTor")}
          onPress={() => void net.setTor(!net.settings.torEnabled)}
        />
      </Section>
      <Section title={t("reach.mirrors")}>
        {(lists?.mirrors ?? []).length === 0 ? <Txt muted>{t("reach.none")}</Txt> : null}
        {lists?.mirrors.map((m) => (
          <Button key={m.url} kind="link" title={m.url} onPress={() => openUrl(m.url)} />
        ))}
      </Section>
      <Section title={t("reach.onion")}>
        <Txt muted>{t("reach.onionHelp")}</Txt>
        {lists?.onions.map((o) => (
          <Txt key={o.address} selectable bold size={14}>
            http://{o.address}
          </Txt>
        ))}
      </Section>
      <Section title={t("reach.ipfs")}>
        {webRelease && webRelease.platform === "web" ? (
          <>
            <Txt selectable size={14}>
              {webRelease.cid}
            </Txt>
            {app.gateways.ipfsLinks(webRelease.cid).map((u) => (
              <Button key={u} kind="link" title={u} onPress={() => openUrl(u)} />
            ))}
          </>
        ) : (
          <Txt muted>{t("reach.none")}</Txt>
        )}
      </Section>
      <Section title={t("reach.apk")}>
        {androidRelease && androidRelease.platform === "android" ? (
          <>
            <Txt>{t("reach.apkVersion", { version: androidRelease.version })}</Txt>
            <Txt muted size={12} selectable>
              SHA-256 {androidRelease.sha256}
            </Txt>
            {androidRelease.urls.map((u) => (
              <Button key={u} kind="link" title={u} onPress={() => openUrl(u)} />
            ))}
          </>
        ) : (
          <Txt muted>{t("reach.none")}</Txt>
        )}
      </Section>
      <Section title={t("reach.offline")}>
        <Txt>{t("reach.offlineHelp")}</Txt>
      </Section>
      <Section title={t("reach.telegram")}>
        <Txt>{config.telegram || t("reach.telegramPending")}</Txt>
      </Section>
      <View />
    </Screen>
  );
}
