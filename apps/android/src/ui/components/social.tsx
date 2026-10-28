import {
  MAX_COMMENT_CHARS,
  REACTIONS,
  type CommentNode,
  type Event,
  type Reaction,
  type StoryRef,
} from "@azaadawaaz/core";
import React, { useEffect, useMemo, useReducer, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { signerFromSecret as signerOf } from "../../api/nip98";
import { StorySocial } from "../../data/social";
import { hideComment, muteKey } from "../../moderator/actions";
import { useServices } from "../context";
import { useI18n } from "../i18n";
import { colors, space } from "../theme";
import { Button, Field, Notice, Row, Section, Txt } from "./basic";

function useSocial(story: StoryRef) {
  const { app, miner } = useServices();
  const social = useMemo(() => new StorySocial(app, story, miner), [app, story, miner]);
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let live = true;
    social.load().then(() => live && force());
    const off = social.watch(force);
    return () => {
      live = false;
      off();
      social.close();
    };
  }, [social]);
  return { social, refresh: force };
}

export function Reactions({ story }: { story: StoryRef }) {
  const { keys } = useServices();
  const { t, num } = useI18n();
  const { social, refresh } = useSocial(story);
  const [busy, setBusy] = useState<Reaction | null>(null);
  const reader = keys.loaded ? keys.reader() : undefined;
  const state = social.state(reader?.pubkey);
  const react = async (r: Reaction) => {
    if (!keys.loaded) return;
    setBusy(r);
    try {
      const kp = await keys.ensureReader();
      const res = await social.react(r, kp.secretKey);
      if (!res.results.some((x) => x.ok)) Alert.alert(t("comments.notAccepted"));
      refresh();
    } catch (e) {
      Alert.alert(t("common.error"), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Row style={{ marginVertical: space.m }}>
      {REACTIONS.map((r) => (
        <Pressable
          key={r}
          accessibilityRole="button"
          accessibilityLabel={r === "⭐" ? t("reactions.important") : r}
          onPress={() => void react(r)}
          disabled={!!busy || state.mine.has(r)}
          style={{
            paddingHorizontal: space.m,
            paddingVertical: space.s,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: state.mine.has(r) ? colors.primary : colors.border,
            backgroundColor: colors.card,
          }}
        >
          <Txt size={15}>{`${r} ${busy === r ? "…" : num(state.reactions[r] ?? 0)}`}</Txt>
        </Pressable>
      ))}
    </Row>
  );
}

function CommentItem({
  node,
  depth,
  onReply,
  moderator,
}: {
  node: CommentNode;
  depth: number;
  onReply: (e: Event) => void;
  moderator?: { hide(e: Event): void; mute(e: Event): void };
}) {
  const { t, date } = useI18n();
  return (
    <View
      style={{
        marginLeft: depth * space.l,
        borderLeftWidth: depth ? 2 : 0,
        borderLeftColor: colors.border,
        paddingLeft: depth ? space.s : 0,
        marginBottom: space.m,
      }}
    >
      <Txt muted size={12}>
        {node.event.pubkey.slice(0, 8)}… · {date(node.event.created_at, true)}
      </Txt>
      <Txt selectable>{node.event.content}</Txt>
      <Row>
        <Button small kind="link" title={t("comments.reply")} onPress={() => onReply(node.event)} />
        {moderator ? (
          <>
            <Button small kind="link" title={t("moderate.hide")} onPress={() => moderator.hide(node.event)} />
            <Button small kind="link" title={t("moderate.mute")} onPress={() => moderator.mute(node.event)} />
          </>
        ) : null}
      </Row>
      {node.replies.map((r) => (
        <CommentItem key={r.event.id} node={r} depth={Math.min(depth + 1, 4)} onReply={onReply} moderator={moderator} />
      ))}
    </View>
  );
}

export function Comments({ story }: { story: StoryRef }) {
  const services = useServices();
  const { keys, app } = services;
  const { t, num } = useI18n();
  const { social, refresh } = useSocial(story);
  const [text, setText] = useState("");
  const [parent, setParent] = useState<Event | undefined>();
  const [busy, setBusy] = useState(false);
  const [backupHint, setBackupHint] = useState(false);
  const state = social.state();
  const mod = keys.loaded ? keys.moderator() : undefined;
  const isActiveModerator = !!mod && !!app.lists?.activeModerators.has(mod.keys.pubkey);
  const post = async () => {
    setBusy(true);
    try {
      const hadKey = !!keys.reader();
      const kp = await keys.ensureReader();
      const res = await social.comment(text, kp.secretKey, parent);
      if (!res.results.some((r) => r.ok)) Alert.alert(t("comments.notAccepted"));
      else {
        setText("");
        setParent(undefined);
        if (!hadKey) setBackupHint(true);
      }
      refresh();
    } catch (e) {
      Alert.alert(t("common.error"), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const moderator = isActiveModerator
    ? {
        hide: (e: Event) =>
          void hideComment(
            app,
            services.api().withSigner(signerOf(mod.keys.secretKey)),
            mod.keys.secretKey,
            mod.keys.pubkey,
            e.id,
          ).then(
            (r) =>
              Alert.alert(
                t("moderate.done"),
                r.auditError ? t("moderate.auditPending", { error: r.auditError }) : undefined,
              ),
            (err) => Alert.alert(t("common.error"), String(err)),
          ),
        mute: (e: Event) =>
          void muteKey(
            app,
            services.api().withSigner(signerOf(mod.keys.secretKey)),
            mod.keys.secretKey,
            mod.keys.pubkey,
            e.pubkey,
          ).then(
            (r) =>
              Alert.alert(
                t("moderate.done"),
                r.auditError ? t("moderate.auditPending", { error: r.auditError }) : undefined,
              ),
            (err) => Alert.alert(t("common.error"), String(err)),
          ),
      }
    : undefined;
  const chars = [...text].length;
  return (
    <Section title={`${t("comments.title")} (${num(state.total)})`}>
      {state.comments.length === 0 ? <Txt muted>{t("comments.empty")}</Txt> : null}
      {state.comments.map((c) => (
        <CommentItem key={c.event.id} node={c} depth={0} onReply={setParent} moderator={moderator} />
      ))}
      {backupHint ? <Notice>{t("keys.backupHelp")}</Notice> : null}
      {keys.loaded ? (
        <View style={{ marginTop: space.m }}>
          {parent ? (
            <Row>
              <Txt muted size={13}>
                {t("comments.replyingTo", { id: parent.pubkey.slice(0, 8) })}
              </Txt>
              <Button small kind="link" title={t("common.cancel")} onPress={() => setParent(undefined)} />
            </Row>
          ) : null}
          <Field
            label={t("comments.placeholder")}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={MAX_COMMENT_CHARS * 2}
          />
          <Row>
            <Txt muted size={13} style={{ flex: 1, color: chars > MAX_COMMENT_CHARS ? colors.bad : colors.muted }}>
              {t("comments.chars", { count: chars, max: MAX_COMMENT_CHARS })}
            </Txt>
            <Button
              title={busy ? t("comments.posting") : t("comments.post")}
              onPress={() => void post()}
              disabled={!text.trim() || chars > MAX_COMMENT_CHARS}
              busy={busy}
            />
          </Row>
        </View>
      ) : (
        <Txt muted>{t("comments.unlockToPost")}</Txt>
      )}
    </Section>
  );
}
