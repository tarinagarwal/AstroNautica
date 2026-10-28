import { CHUNK_SIZE, generateKeyPair, newContentKey } from "@azaadawaaz/core";
import type { Lang, LocalizedText, StoryLanguage } from "@azaadawaaz/schema";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { ApiError, type MySubmission } from "../../api/client";
import { signerFromSecret } from "../../api/nip98";
import {
  DEFAULT_MEDIA_LIMITS,
  draftLangs,
  draftMedia,
  moveBlock,
  newBlockId,
  newDraft,
  toApprovalBody,
  validateDraft,
  withStoryId,
  type Draft,
  type DraftBlock,
  type StrippedMedia,
} from "../../contributor/draft";
import { parseInvite, redemptionFor } from "../../contributor/invite";
import { MediaError, prepareImage, prepareVideo } from "../../contributor/media";
import { canEdit, decryptFeedback, stateKey } from "../../contributor/submissions";
import { KeyCheckError, newUploadState, recipientsFor, runUpload, type UploadProgress, type UploadState } from "../../contributor/upload";
import { nativeDocuments } from "../../platform/nativeFiles";
import { joinPath } from "../../platform/types";
import { LockRequiredError } from "../../security/keys";
import { base64ToBytes, bytesToBase64 } from "../../util/bytes";
import { useObservable, useServices } from "../context";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { space } from "../theme";
import { Badge, Button, Card, Choice, Field, Loading, Notice, Row, Screen, Section, Txt } from "../components/basic";
import { LocalImage } from "../components/media";

const DRAFT_INDEX = "drafts:index";

async function loadDraftIndex(store: { get<T>(k: string): Promise<T | undefined> }): Promise<string[]> {
  return (await store.get<string[]>(DRAFT_INDEX)) ?? [];
}

export function ContributeScreen() {
  const services = useServices();
  const { keys, drafts } = services;
  const { t, date } = useI18n();
  const nav = useNav();
  const [subs, setSubs] = useState<MySubmission[] | null>(null);
  const [subsError, setSubsError] = useState<string>();
  const [draftList, setDraftList] = useState<Draft[]>([]);
  useObservable(keys);
  const kp = keys.loaded ? keys.contributor() : undefined;

  const refresh = useCallback(async () => {
    const ids = await loadDraftIndex(drafts);
    const ds = (await Promise.all(ids.map((id) => drafts.get<Draft>(`draft:${id}`)))).filter((d): d is Draft => !!d);
    setDraftList(ds.sort((a, b) => b.updatedAt - a.updatedAt));
    if (!kp) return;
    try {
      setSubs(await services.api().withSigner(signerFromSecret(kp.secretKey)).mySubmissions());
      setSubsError(undefined);
    } catch (e) {
      setSubsError(e instanceof Error ? e.message : String(e));
    }
  }, [drafts, kp, services]);
  useEffect(() => void refresh(), [refresh]);

  if (!keys.loaded) return <Screen title={t("contrib.title")}><Notice>{t("keys.locked")}</Notice></Screen>;
  if (!kp)
    return (
      <Screen title={t("contrib.title")}>
        <Txt style={{ marginBottom: space.m }}>{t("contrib.intro")}</Txt>
        <Txt muted style={{ marginBottom: space.m }}>{t("contrib.inviteHelp")}</Txt>
        <Button title={t("invite.open")} onPress={() => nav.push({ name: "invite" })} />
      </Screen>
    );
  const draftFor = (submissionId: string) => draftList.find((d) => d.submissionId === submissionId);
  return (
    <Screen title={t("contrib.title")}>
      <Txt muted style={{ marginBottom: space.m }}>{t("contrib.intro")}</Txt>
      <Button title={t("contrib.new")} onPress={() => nav.push({ name: "editor" })} />
      <Section title={t("contrib.drafts")}>
        {draftList.filter((d) => !d.submissionId).length === 0 ? <Txt muted>{t("contrib.noDrafts")}</Txt> : null}
        {draftList
          .filter((d) => !d.submissionId)
          .map((d) => (
            <Card key={d.localId} onPress={() => nav.push({ name: "editor", draftId: d.localId })}>
              <Txt bold>{d.title.en || d.title.hi || t("contrib.untitled")}</Txt>
              <Txt muted size={13}>{t("contrib.updated", { date: date(d.updatedAt, true) })}</Txt>
            </Card>
          ))}
      </Section>
      <Section title={t("contrib.mine")}>
        {subsError ? <Notice tone="bad">{subsError}</Notice> : null}
        {subs === null && !subsError ? <Loading /> : null}
        {subs?.length === 0 ? <Txt muted>{t("contrib.none")}</Txt> : null}
        {subs?.map((s) => {
          const d = draftFor(s.id);
          return (
            <Card key={s.id}>
              <Row>
                <Txt bold style={{ flex: 1 }}>{d ? d.title.en || d.title.hi : t("contrib.untitled")}</Txt>
                <Badge tone={s.state === "published" ? "ok" : s.state === "rejected" ? "bad" : s.state === "changes_requested" ? "warn" : "neutral"} label={t(stateKey(s.state))} />
              </Row>
              <Txt muted size={13}>
                {t("contrib.version", { version: s.version })} · {t("contrib.updated", { date: date(s.updatedAt, true) })}
              </Txt>
              {s.feedback.map((f, i) => {
                const dec = decryptFeedback(f, kp.secretKey);
                return (
                  <Notice key={i} tone={f.kind === "reject" ? "bad" : "warn"}>
                    <Txt bold size={14}>{f.kind === "reject" ? t("contrib.rejectedBecause") : t("contrib.changesRequested")}</Txt>
                    <Txt size={14}>{dec.text ?? t("contrib.feedbackUnreadable")}</Txt>
                  </Notice>
                );
              })}
              {canEdit(s) && d ? <Button small title={t("contrib.editResubmit")} onPress={() => nav.push({ name: "editor", draftId: d.localId })} /> : null}
              {canEdit(s) && !d ? <Txt muted size={13}>{t("contrib.draftMissing")}</Txt> : null}
              {s.state === "published" ? <Button small kind="secondary" title={t("contrib.view")} onPress={() => nav.push({ name: "story", storyId: s.storyId })} /> : null}
            </Card>
          );
        })}
        <Button kind="secondary" title={t("common.refresh")} onPress={() => void refresh()} />
      </Section>
    </Screen>
  );
}

export function InviteScreen({ link }: { link?: string }) {
  const services = useServices();
  const { keys, config } = services;
  const { t, date } = useI18n();
  const nav = useNav();
  const [text, setText] = useState(link ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const parsed = text.trim() ? parseInvite(text, config.ownerPubkey) : null;
  const redeem = async () => {
    if (!parsed?.ok) return;
    if ((await keys.state()).lock === "none") {
      nav.push({ name: "pinSetup", then: { name: "invite", link: text } });
      return;
    }
    setBusy(true);
    try {
      const kp = keys.contributor() ?? generateKeyPair();
      const redemption = redemptionFor(parsed.event, kp.secretKey);
      await services.api().redeemInvite(redemption);
      await keys.setContributor(kp.secretKey);
      setDone(true);
    } catch (e) {
      if (e instanceof LockRequiredError) nav.push({ name: "pinSetup", then: { name: "invite", link: text } });
      else Alert.alert(t("common.error"), e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <Screen title={t("invite.title")}>
        <Notice tone="ok">{t("invite.done")}</Notice>
        <Txt muted style={{ marginBottom: space.m }}>{t("invite.backup")}</Txt>
        <Button title={t("contrib.title")} onPress={() => nav.replace({ name: "contribute" })} />
      </Screen>
    );
  return (
    <Screen title={t("invite.title")}>
      <Txt style={{ marginBottom: space.m }}>{t("invite.help")}</Txt>
      <Field label={t("invite.link")} value={text} onChangeText={setText} autoCapitalize="none" multiline />
      {parsed && !parsed.ok ? <Notice tone="bad">{t("invite.invalid", { error: parsed.error })}</Notice> : null}
      {parsed?.ok ? (
        <Notice tone="ok">
          <Txt>{t("invite.valid")}</Txt>
          {parsed.content.note ? <Txt muted size={14}>{parsed.content.note}</Txt> : null}
          {parsed.content.expiresAt ? <Txt muted size={14}>{t("invite.expires", { date: date(parsed.content.expiresAt) })}</Txt> : null}
        </Notice>
      ) : null}
      <Button title={t("invite.redeem")} disabled={!parsed?.ok} busy={busy} onPress={() => void redeem()} />
      <Txt muted size={13}>{t("invite.lockNote")}</Txt>
    </Screen>
  );
}

function LangFields({
  label,
  value,
  onChange,
  langs,
  multiline,
  help,
}: {
  label: string;
  value: LocalizedText;
  onChange: (v: LocalizedText) => void;
  langs: Lang[];
  multiline?: boolean;
  help?: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {langs.map((l) => (
        <Field
          key={l}
          label={langs.length > 1 ? `${label} (${t(`lang.${l}`)})` : label}
          value={value[l] ?? ""}
          onChangeText={(s) => onChange({ ...value, [l]: s })}
          multiline={multiline}
          help={help}
        />
      ))}
    </>
  );
}

function MediaBadge({ m }: { m: StrippedMedia }) {
  const { t } = useI18n();
  return m.metadataFree ? <Badge tone="ok" label={t("editor.metadataRemoved")} /> : <Badge tone="bad" label={t("editor.problem.metadata")} />;
}

export function EditorScreen({ draftId }: { draftId?: string }) {
  const services = useServices();
  const { drafts, keys, app, fs } = services;
  const { t } = useI18n();
  const nav = useNav();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string>();
  const [showProblems, setShowProblems] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useObservable(keys);
  const kp = keys.loaded ? keys.contributor() : undefined;

  useEffect(() => {
    let live = true;
    (async () => {
      const d = draftId ? await drafts.get<Draft>(`draft:${draftId}`) : undefined;
      if (live) setDraft(d ?? newDraft());
    })();
    return () => {
      live = false;
    };
  }, [draftId, drafts]);

  const update = (next: Draft) => {
    const d = { ...next, updatedAt: Date.now() };
    setDraft(d);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await drafts.set(`draft:${d.localId}`, d);
      const ids = await loadDraftIndex(drafts);
      if (!ids.includes(d.localId)) await drafts.set(DRAFT_INDEX, [d.localId, ...ids]);
    }, 400);
  };

  if (!draft || !keys.loaded) return <Screen title={t("editor.title")}><Loading /></Screen>;
  if (!kp) return <Screen title={t("editor.title")}><Notice>{t("contrib.inviteHelp")}</Notice></Screen>;
  const current = draft;
  const langs = draftLangs(draft.language);
  const workDir = joinPath(fs.paths.files, "drafts", draft.localId);
  const problems = validateDraft(draft, kp.npub, DEFAULT_MEDIA_LIMITS);
  const setBlock = (i: number, b: DraftBlock) => update({ ...draft, blocks: draft.blocks.map((x, j) => (j === i ? b : x)) });
  const removeBlock = (i: number) => update({ ...draft, blocks: draft.blocks.filter((_, j) => j !== i) });

  const mediaError = (e: unknown) =>
    Alert.alert(t("common.error"), e instanceof MediaError ? `${t(e.key)}\n${e.message}` : e instanceof Error ? e.message : String(e));

  const addImages = async (i: number) => {
    const picked = await nativeDocuments.pick(["image/*"], true);
    if (!picked.length) return;
    setWorking(t("editor.stripping"));
    try {
      const block = draft.blocks[i];
      if (block?.type !== "image") return;
      const items = [...block.items];
      for (const p of picked) items.push({ media: await prepareImage(fs, services.mediaTools, p.uri, workDir, DEFAULT_MEDIA_LIMITS), caption: {} });
      setBlock(i, { ...block, items });
    } catch (e) {
      mediaError(e);
    } finally {
      setWorking(null);
    }
  };

  const pickVideo = async (i: number) => {
    const [p] = await nativeDocuments.pick(["video/*"], false);
    if (!p) return;
    setWorking(t("editor.stripping"));
    try {
      const block = draft.blocks[i];
      if (block?.type !== "video") return;
      setBlock(i, { ...block, video: await prepareVideo(fs, services.mediaTools, p.uri, workDir, DEFAULT_MEDIA_LIMITS) });
    } catch (e) {
      mediaError(e);
    } finally {
      setWorking(null);
    }
  };

  const pickCover = async () => {
    const [p] = await nativeDocuments.pick(["image/*"], false);
    if (!p) return;
    setWorking(t("editor.stripping"));
    try {
      update({ ...draft, cover: await prepareImage(fs, services.mediaTools, p.uri, workDir, DEFAULT_MEDIA_LIMITS) });
    } catch (e) {
      mediaError(e);
    } finally {
      setWorking(null);
    }
  };

  const submit = async () => {
    setShowProblems(true);
    if (problems.length) return;
    // The story id is generated now, at submission, and saved before anything is sent.
    const draft = withStoryId(current);
    if (draft !== current) {
      setDraft(draft);
      await drafts.set(`draft:${draft.localId}`, draft);
    }
    if (!app.lists) return setError(t("banner.noLists"));
    setError(undefined);
    setWorking(t("editor.progress.encrypting", { done: 0, total: 0 }));
    try {
      const api = services.api().withSigner(signerFromSecret(kp.secretKey));
      const recipients = recipientsFor(await api.config(), app.lists);
      const body = toApprovalBody(draft, kp.npub);
      let keyB64 = keys.contentKey(draft.localId);
      if (!keyB64) {
        keyB64 = bytesToBase64(await newContentKey());
        await keys.setContentKey(draft.localId, keyB64);
      }
      const contentKey = base64ToBytes(keyB64);
      const stateKey = `upload:${draft.localId}`;
      const prev = await drafts.get<UploadState>(stateKey);
      const media = draftMedia(draft);
      let state: UploadState;
      if (prev && prev.phase !== "submitted" && JSON.stringify(prev.media.map((m) => m.sha256)) === JSON.stringify(media.map((m) => m.sha256))) {
        state = prev;
      } else {
        state = newUploadState({
          draftId: draft.localId,
          contentKey,
          storyId: draft.storyId,
          version: draft.version,
          supersedes: draft.supersedes,
          media,
          workDir: joinPath(workDir, "enc"),
          submissionId: draft.submissionId ?? prev?.submissionId,
          toB64: bytesToBase64,
        });
        // Media the server already holds from an earlier round (same file, same content key) is not sent again.
        for (const m of state.media) {
          const old = prev?.media.find((x) => x.sha256 === m.sha256 && x.done);
          if (old) Object.assign(m, { headerB64: old.headerB64, chunks: old.chunks ?? [...Array(Math.max(1, Math.ceil(m.size / CHUNK_SIZE))).keys()].map((n) => ({ n, size: 0, sha256: "", path: "" })), done: true });
        }
      }
      const final = await runUpload(
        state,
        body,
        recipients,
        contentKey,
        {
          api,
          encryptFile: services.encryptFile,
          removeDir: (dir) => fs.remove(dir),
          saveState: async (s) => {
            await drafts.set(stateKey, s);
            if (s.submissionId && s.submissionId !== draft.submissionId) {
              const d = { ...draft, submissionId: s.submissionId };
              await drafts.set(`draft:${d.localId}`, d);
            }
          },
          workDir: joinPath(workDir, "enc"),
          onProgress: setProgress,
        },
        { toB64: bytesToBase64, fromB64: base64ToBytes },
      );
      const d = { ...draft, submissionId: final.submissionId };
      await drafts.set(`draft:${d.localId}`, d);
      Alert.alert(t("editor.progress.done"));
      nav.replace({ name: "contribute" });
    } catch (e) {
      setError(
        e instanceof KeyCheckError
          ? `${t("editor.keyCheck")}\n${e.message}`
          : e instanceof ApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      );
    } finally {
      setWorking(null);
      setProgress(null);
    }
  };

  const addBlock = (type: DraftBlock["type"]) => {
    const id = newBlockId();
    const b: DraftBlock =
      type === "text"
        ? { id, type, markdown: {} }
        : type === "image"
          ? { id, type, items: [] }
          : type === "video"
            ? { id, type, video: null, title: {}, description: {} }
            : { id, type, storyId: "" };
    update({ ...draft, blocks: [...draft.blocks, b] });
  };

  return (
    <Screen title={draft.version > 1 ? t("editor.correctionTitle", { version: draft.version }) : t("editor.title")}>
      <Notice tone="ok">{t("editor.privacy")}</Notice>
      <Txt muted size={13} style={{ marginBottom: space.m }}>{t("editor.autosave")}</Txt>
      <Txt muted size={14}>{t("editor.language")}</Txt>
      <Choice<StoryLanguage>
        value={draft.language}
        onChange={(language) => update({ ...draft, language })}
        options={[
          { value: "en", label: t("editor.lang.en") },
          { value: "hi", label: t("editor.lang.hi") },
          { value: "both", label: t("editor.lang.both") },
        ]}
      />
      <LangFields label={t("editor.storyTitle")} value={draft.title} onChange={(title) => update({ ...draft, title })} langs={langs} />
      <LangFields label={t("editor.summary")} value={draft.summary} onChange={(summary) => update({ ...draft, summary })} langs={langs} multiline help={t("editor.summaryHelp")} />
      <Field
        label={t("editor.tags")}
        value={draft.tags.join(", ")}
        onChangeText={(s) => update({ ...draft, tags: s.split(",").map((x) => x.trimStart()) })}
        help={t("editor.tagsHelp", { max: 10 })}
      />
      <LangFields label={t("editor.location")} value={draft.location} onChange={(location) => update({ ...draft, location })} langs={langs} help={t("editor.locationHelp")} />
      <Field label={t("editor.penName")} value={draft.displayName} onChangeText={(displayName) => update({ ...draft, displayName })} />
      <Section title={t("editor.cover")}>
        {draft.cover ? (
          <>
            <LocalImage path={draft.cover.path} />
            <MediaBadge m={draft.cover} />
            <Button small kind="link" title={t("editor.remove")} onPress={() => update({ ...draft, cover: null })} />
          </>
        ) : (
          <Button small kind="secondary" title={t("editor.uploadCover")} onPress={() => void pickCover()} />
        )}
      </Section>
      <Section title={t("editor.blocks")}>
        {draft.blocks.map((b, i) => (
          <Card key={b.id}>
            <Row>
              <Txt bold style={{ flex: 1 }}>{t(`editor.block.${b.type}`)}</Txt>
              <Button small kind="link" title="↑" onPress={() => update(moveBlock(draft, i, -1))} />
              <Button small kind="link" title="↓" onPress={() => update(moveBlock(draft, i, 1))} />
              <Button small kind="link" title={t("editor.remove")} onPress={() => removeBlock(i)} />
            </Row>
            {b.type === "text" ? (
              <LangFields label={t("editor.markdown")} value={b.markdown} onChange={(markdown) => setBlock(i, { ...b, markdown })} langs={langs} multiline />
            ) : null}
            {b.type === "image" ? (
              <>
                {b.items.map((it, j) => (
                  <View key={it.media.sha256 + j} style={{ marginBottom: space.m }}>
                    <LocalImage path={it.media.path} />
                    <MediaBadge m={it.media} />
                    <LangFields
                      label={t("editor.caption")}
                      value={it.caption}
                      onChange={(caption) => setBlock(i, { ...b, items: b.items.map((x, k) => (k === j ? { ...x, caption } : x)) })}
                      langs={langs}
                    />
                    <Row>
                      <Button small kind="link" title={t("editor.useAsCover")} onPress={() => update({ ...draft, cover: it.media })} />
                      <Button small kind="link" title={t("editor.remove")} onPress={() => setBlock(i, { ...b, items: b.items.filter((_, k) => k !== j) })} />
                    </Row>
                  </View>
                ))}
                <Button small kind="secondary" title={t("editor.addImages")} onPress={() => void addImages(i)} />
              </>
            ) : null}
            {b.type === "video" ? (
              <>
                {b.video ? (
                  <>
                    <Txt size={14}>{t("editor.videoChosen", { mb: Math.round(b.video.size / 1024 / 1024) })}</Txt>
                    <MediaBadge m={b.video} />
                  </>
                ) : (
                  <Button small kind="secondary" title={t("editor.chooseVideo")} onPress={() => void pickVideo(i)} />
                )}
                <LangFields label={t("editor.videoTitle")} value={b.title} onChange={(title) => setBlock(i, { ...b, title })} langs={langs} />
                <LangFields label={t("editor.videoDescription")} value={b.description} onChange={(description) => setBlock(i, { ...b, description })} langs={langs} multiline />
              </>
            ) : null}
            {b.type === "embed-story" ? (
              <>
                <Field label={t("editor.embedId")} value={b.storyId} onChangeText={(storyId) => setBlock(i, { ...b, storyId })} autoCapitalize="none" />
                <Field
                  label={t("editor.embedVersion")}
                  value={b.version ? String(b.version) : ""}
                  keyboardType="number-pad"
                  onChangeText={(s) => setBlock(i, { ...b, version: s ? Number(s) || undefined : undefined })}
                />
              </>
            ) : null}
          </Card>
        ))}
        <Row>
          <Button small kind="secondary" title={t("editor.addText")} onPress={() => addBlock("text")} />
          <Button small kind="secondary" title={t("editor.addGallery")} onPress={() => addBlock("image")} />
          <Button small kind="secondary" title={t("editor.addVideo")} onPress={() => addBlock("video")} />
          <Button small kind="secondary" title={t("editor.addEmbed")} onPress={() => addBlock("embed-story")} />
        </Row>
      </Section>
      {showProblems && problems.length ? (
        <Notice tone="bad">
          <Txt bold>{t("editor.fixErrors")}</Txt>
          {problems.map((p, i) => (
            <Txt key={i} size={14}>• {p.detail ?? t(p.key, p.vars)}</Txt>
          ))}
        </Notice>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {working ? <Loading label={progress ? t(`editor.progress.${progress.phase === "uploading" ? "uploading" : "encrypting"}`, { done: progress.sentChunks, total: progress.totalChunks }) : working} /> : null}
      <Button title={t("editor.submit")} busy={!!working} onPress={() => void submit()} />
    </Screen>
  );
}
