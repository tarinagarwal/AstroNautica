import { pickText } from "@azaadawaaz/core";
import type { ApprovalBody, Lang } from "@azaadawaaz/schema";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import Video from "react-native-video";
import { ApiError, type MediaMeta, type QueueItem } from "../../api/client";
import { signerFromSecret } from "../../api/nip98";
import { syncContributors } from "../../moderator/actions";
import { previewMedia } from "../../moderator/preview";
import { approve, claim, identityFrom, openSubmission, rejectSubmission, requestChanges, rewrapPending, type OpenedSubmission } from "../../moderator/review";
import { nativeDocuments } from "../../platform/nativeFiles";
import { joinPath } from "../../platform/types";
import { LockRequiredError } from "../../security/keys";
import { useObservable, useServices } from "../context";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { space } from "../theme";
import { Badge, Button, Card, Choice, Field, Loading, Notice, Row, Screen, Section, Txt } from "../components/basic";
import { LocalImage, Markdown } from "../components/media";

function useModerator() {
  const { keys } = useServices();
  useObservable(keys);
  const m = keys.loaded ? keys.moderator() : undefined;
  return useMemo(() => (m ? identityFrom(m.keys.secretKey, m.x25519) : undefined), [m?.keys.pubkey, m?.x25519.publicKey]); // eslint-disable-line
}

export function ModerateScreen() {
  const services = useServices();
  const { keys, app } = services;
  const { t, date } = useI18n();
  const nav = useNav();
  const me = useModerator();
  const [nsec, setNsec] = useState("");
  const [x25519, setX25519] = useState("");
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  useObservable(app);

  const api = useMemo(() => (me ? services.api().withSigner(signerFromSecret(me.secretKey)) : null), [me, services]);
  const load = useCallback(async () => {
    if (!api || !me) return;
    try {
      setQueue(await api.queue());
      setError(undefined);
      const sync = await syncContributors(app, api, me.secretKey, me.pubkey).catch(() => undefined);
      const allowed = new Set([
        ...(app.lists?.moderators.filter((m) => app.lists!.activeModerators.has(m.pubkey)).map((m) => m.x25519) ?? []),
        ...(app.lists?.serviceKeys.filter((k) => k.role === "owner" && k.x25519).map((k) => k.x25519!) ?? []),
      ]);
      const rewrapped = await rewrapPending(api, me, allowed).catch(() => []);
      if ((sync && (sync.added.length || sync.revoked.length)) || rewrapped.length)
        setInfo(t("moderate.synced", { added: sync?.added.length ?? 0, revoked: sync?.revoked.length ?? 0, rewrapped: rewrapped.length }));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  }, [api, me, app, t]);
  useEffect(() => void load(), [load]);

  if (!keys.loaded) return <Screen title={t("moderate.title")}><Notice>{t("keys.locked")}</Notice></Screen>;
  if (!me)
    return (
      <Screen title={t("moderate.title")}>
        <Txt style={{ marginBottom: space.m }}>{t("moderate.loginHelp")}</Txt>
        <Field label={t("moderate.nsec")} value={nsec} onChangeText={setNsec} autoCapitalize="none" secureTextEntry />
        <Field label={t("moderate.x25519")} value={x25519} onChangeText={setX25519} autoCapitalize="none" secureTextEntry />
        <Button
          title={t("moderate.login")}
          disabled={!nsec || !x25519}
          onPress={() =>
            void keys.setModerator(nsec, x25519).then(
              (r) => {
                setNsec("");
                setX25519("");
                const listed = app.lists?.moderators.find((m) => m.pubkey === r.pubkey);
                if (!listed) Alert.alert(t("moderate.notListed"));
                else if (listed.x25519 !== r.x25519) Alert.alert(t("moderate.x25519Mismatch"));
              },
              (e) => (e instanceof LockRequiredError ? nav.push({ name: "pinSetup", then: { name: "moderate" } }) : Alert.alert(t("common.error"), String(e))),
            )
          }
        />
      </Screen>
    );
  const active = app.lists?.activeModerators.has(me.pubkey);
  return (
    <Screen title={t("moderate.title")}>
      {!active ? <Notice tone="bad">{t("moderate.notListed")}</Notice> : null}
      {info ? <Notice tone="ok">{info}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Section title={t("moderate.queue")}>
        {queue === null && !error ? <Loading /> : null}
        {queue?.length === 0 ? <Txt muted>{t("moderate.empty")}</Txt> : null}
        {queue?.map((q) => (
          <Card key={q.id} onPress={() => nav.push({ name: "review", submissionId: q.id })}>
            <Row>
              <Txt bold style={{ flex: 1 }}>{q.storyId.slice(0, 13)}… v{q.version}</Txt>
              <Badge tone={q.state === "in_review" ? "warn" : "neutral"} label={t(`submission.state.${q.state}`)} />
            </Row>
            <Txt muted size={13}>
              {q.submittedAt ? t("moderate.submitted", { date: date(q.submittedAt, true) }) : ""}
              {q.claimBy ? ` · ${t("moderate.claimedBy", { who: q.claimBy === me.pubkey ? t("moderate.you") : q.claimBy.slice(0, 8) })}` : ""}
            </Txt>
            {q.wrappedForMe === false ? <Txt muted size={13}>{t("moderate.noWrap")}</Txt> : null}
          </Card>
        ))}
        <Button kind="secondary" title={t("common.refresh")} onPress={() => void load()} />
      </Section>
    </Screen>
  );
}

function MediaPreview({ opened, sha, kind }: { opened: OpenedSubmission; sha: string; kind: "image" | "video" }) {
  const services = useServices();
  const { t } = useI18n();
  const [path, setPath] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const me = useModerator();
  const meta = opened.detail.media.find((m: MediaMeta) => m.sha256 === sha);
  const load = async () => {
    if (!meta || !me) return;
    setError(undefined);
    try {
      const signer = signerFromSecret(me.secretKey);
      setPath(
        await previewMedia({
          api: services.api().withSigner(signer),
          http: services.http,
          fs: services.fs,
          signer,
          decryptor: services.decryptor,
          submissionId: opened.detail.id,
          media: meta,
          contentKey: opened.contentKey,
          workDir: joinPath(services.fs.paths.cache, "review", opened.detail.id),
          onProgress: (d, n) => setProgress(`${d}/${n}`),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (kind === "image") void load();
  }, [sha]); // eslint-disable-line
  if (!meta) return <Notice tone="bad">{t("moderate.mediaMissing")}</Notice>;
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!path)
    return kind === "video" ? (
      <Button small kind="secondary" title={progress ? t("moderate.decrypting", { progress }) : t("moderate.previewVideo", { mb: Math.round(meta.size / 1024 / 1024) })} onPress={() => void load()} />
    ) : (
      <Loading label={progress} />
    );
  return kind === "image" ? (
    <LocalImage path={path} />
  ) : (
    <Video source={{ uri: `file://${path}` }} controls style={{ width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000" }} resizeMode="contain" />
  );
}

function BodyPreview({ opened }: { opened: OpenedSubmission }) {
  const { t } = useI18n();
  const body: ApprovalBody = opened.body;
  const langs: Lang[] = body.language === "both" ? ["en", "hi"] : [body.language];
  const [lang, setLang] = useState<Lang>(langs[0]!);
  return (
    <View>
      {langs.length > 1 ? <Choice value={lang} onChange={setLang} options={langs.map((l) => ({ value: l, label: t(`lang.${l}`) }))} /> : null}
      <Txt bold size={22} lang={lang}>{pickText(body.title, lang)}</Txt>
      <Txt muted size={14}>{t("story.by", { name: body.contributor.displayName })}</Txt>
      <Txt style={{ fontStyle: "italic", marginVertical: space.m }} lang={lang}>{pickText(body.summary, lang)}</Txt>
      {body.cover ? <MediaPreview opened={opened} sha={body.cover.sha256} kind="image" /> : null}
      {body.blocks.map((b, i) => (
        <View key={i} style={{ marginBottom: space.m }}>
          {b.type === "text" ? <Markdown source={pickText(b.markdown, lang)} lang={lang} /> : null}
          {b.type === "image"
            ? b.items.map((it) => (
                <View key={it.sha256} style={{ marginBottom: space.s }}>
                  <MediaPreview opened={opened} sha={it.sha256} kind="image" />
                  {it.caption ? <Txt muted size={14}>{pickText(it.caption, lang)}</Txt> : null}
                </View>
              ))
            : null}
          {b.type === "video" ? (
            <>
              {b.title ? <Txt bold>{pickText(b.title, lang)}</Txt> : null}
              <MediaPreview opened={opened} sha={b.source.sha256} kind="video" />
              {b.description ? <Txt muted size={14}>{pickText(b.description, lang)}</Txt> : null}
            </>
          ) : null}
          {b.type === "embed-story" ? <Card><Txt>{t("embed.label")}: {b.storyId}{b.version ? ` v${b.version}` : ""}</Txt></Card> : null}
        </View>
      ))}
      {body.tags.length ? <Txt muted size={14}>{body.tags.map((x) => `#${x}`).join(" ")}</Txt> : null}
      {body.location ? <Txt muted size={14}>{pickText(body.location, lang)}</Txt> : null}
    </View>
  );
}

export function ReviewScreen({ submissionId }: { submissionId: string }) {
  const services = useServices();
  const { app } = services;
  const { t } = useI18n();
  const nav = useNav();
  const me = useModerator();
  const [opened, setOpened] = useState<OpenedSubmission | null>(null);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const api = useMemo(() => (me ? services.api().withSigner(signerFromSecret(me.secretKey)) : null), [me, services]);

  useEffect(() => {
    nativeDocuments.setSecureScreen(true);
    return () => nativeDocuments.setSecureScreen(false);
  }, []);

  useEffect(() => {
    if (!api || !me) return;
    let live = true;
    (async () => {
      await claim(api, submissionId, me).catch(() => undefined);
      const o = await openSubmission(api, submissionId, me);
      if (live) setOpened(o);
    })().catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, me, submissionId]);

  if (!me || !api) return <Screen title={t("moderate.review")}><Notice>{t("keys.locked")}</Notice></Screen>;
  if (error) return <Screen title={t("moderate.review")}><Notice tone="bad">{error}</Notice></Screen>;
  if (!opened) return <Screen title={t("moderate.review")}><Loading label={t("moderate.decryptingBody")} /></Screen>;

  const act = async (kind: "approve" | "reject" | "changes") => {
    setBusy(kind);
    try {
      if (kind === "approve") {
        if (!app.lists) throw new Error(t("banner.noLists"));
        await approve(api, opened, me, app.lists, await api.config().catch(() => undefined));
      } else if (kind === "reject") await rejectSubmission(api, opened.detail, me, feedback);
      else await requestChanges(api, opened.detail, me, feedback);
      Alert.alert(t("moderate.done"));
      nav.back();
    } catch (e) {
      Alert.alert(t("common.error"), e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const confirm = (kind: "approve" | "reject" | "changes") =>
    Alert.alert(t(`moderate.confirm.${kind}`), t(`moderate.confirmBody.${kind}`), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.ok"), onPress: () => void act(kind) },
    ]);

  return (
    <Screen title={t("moderate.review")}>
      {opened.problems.length ? (
        <Notice tone="bad">
          <Txt bold>{t("moderate.problems")}</Txt>
          {opened.problems.map((p) => (
            <Txt key={p} size={13}>• {p}</Txt>
          ))}
        </Notice>
      ) : (
        <Notice tone="ok">{t("moderate.bodyOk")}</Notice>
      )}
      <Card>
        <BodyPreview opened={opened} />
      </Card>
      <Section title={t("moderate.decision")}>
        <Button title={t("moderate.approve")} busy={busy === "approve"} disabled={!!opened.problems.length || !!busy} onPress={() => confirm("approve")} />
        <Field label={t("moderate.feedback")} value={feedback} onChangeText={setFeedback} multiline help={t("moderate.feedbackHelp")} />
        <Row>
          <Button kind="secondary" title={t("moderate.requestChanges")} busy={busy === "changes"} disabled={!feedback.trim() || !!busy} onPress={() => confirm("changes")} />
          <Button kind="danger" title={t("moderate.reject")} busy={busy === "reject"} disabled={!feedback.trim() || !!busy} onPress={() => confirm("reject")} />
        </Row>
      </Section>
    </Screen>
  );
}
