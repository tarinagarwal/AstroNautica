import React, { useEffect, useState } from "react";
import { Alert, PermissionsAndroid, Platform } from "react-native";
import NativeAzaadP2P from "../../native/specs/NativeAzaadP2P";
import {
  BUNDLE_EXT,
  BUNDLE_MIME,
  BundleError,
  exportBundle,
  importBundle,
  type VerifiedBundle,
} from "../../offline/bundle";
import type { SavedEntry } from "../../offline/store";
import { nativeDocuments } from "../../platform/nativeFiles";
import { onNativeEvent } from "../../platform/nativeEvents";
import { joinPath } from "../../platform/types";
import { useObservable, useServices } from "../context";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { space } from "../theme";
import { Badge, Button, Card, Loading, Notice, Row, Screen, Section, Toggle, Txt } from "../components/basic";

export function SavedScreen() {
  const { offline } = useServices();
  const { t, date, num } = useI18n();
  const nav = useNav();
  const [items, setItems] = useState<SavedEntry[] | null>(null);
  const load = () => void offline.list().then(setItems);
  useEffect(load, [offline]);
  return (
    <Screen title={t("nav.saved")}>
      <Txt muted style={{ marginBottom: space.m }}>
        {t("offline.help")}
      </Txt>
      {items === null ? <Loading /> : null}
      {items?.length === 0 ? <Txt muted>{t("offline.none")}</Txt> : null}
      {items?.map((e) => (
        <Card key={e.storyId} onPress={() => nav.push({ name: "story", storyId: e.storyId, offline: true })}>
          <Txt bold>{e.title}</Txt>
          <Row>
            <Txt muted size={13}>
              {date(e.savedAt)} · {num(Math.round(e.bytes / 1024 / 1024))} MB
            </Txt>
            {e.source === "bundle" ? <Badge tone="neutral" label={t("offline.fromPhone")} /> : null}
          </Row>
          <Button
            small
            kind="link"
            title={t("offline.remove")}
            onPress={() => void offline.remove(e.storyId).then(load)}
          />
        </Card>
      ))}
    </Screen>
  );
}

/** Wi-Fi Direct needs location (Android ≤ 12) or nearby-devices (13+) permission. */
async function requestP2pPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const perms =
    Number(Platform.Version) >= 33
      ? ["android.permission.NEARBY_WIFI_DEVICES"]
      : ["android.permission.ACCESS_FINE_LOCATION"];
  const res = await PermissionsAndroid.requestMultiple(perms as never);
  return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

interface Peer {
  name: string;
  address: string;
  status: number;
}

type P2pEvent =
  | { type: "peers"; peers: Peer[] }
  | { type: "state"; state: string; message?: string }
  | { type: "progress"; bytes: number; total: number }
  | { type: "received"; path: string; size: number; sha256: string }
  | { type: "sent" }
  | { type: "error"; message: string };

function usePeerTransfer(onReceived?: (path: string) => void) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    const off = onNativeEvent<P2pEvent>("azaadP2p", (e) => {
      if (e.type === "peers") setPeers(e.peers);
      else if (e.type === "state") setStatus(e.message ?? e.state);
      else if (e.type === "progress") setProgress(e.total > 0 ? e.bytes / e.total : 0);
      else if (e.type === "received") {
        setProgress(null);
        onReceived?.(e.path);
      } else if (e.type === "sent") {
        setProgress(null);
        setStatus("sent");
      } else if (e.type === "error") {
        setProgress(null);
        setStatus(e.message);
      }
    });
    return () => {
      off();
      void NativeAzaadP2P.stop();
    };
  }, [onReceived]);
  return { peers, status, progress };
}

export function ShareScreen({ storyId }: { storyId: string }) {
  const services = useServices();
  const { app, fs, media, offline } = services;
  const { t } = useI18n();
  const [includeVideo, setIncludeVideo] = useState(false);
  const [zip, setZip] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [direct, setDirect] = useState(false);
  const transfer = usePeerTransfer();
  useObservable(app);

  const build = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const found = await app.getStory(storyId);
      if (!found || !app.lists) throw new Error(t("story.notFound"));
      const m = await app.loadManifest(found.ref);
      if (!m.check.ok || !m.check.manifest) throw new Error(t("verify.failed"));
      const out = joinPath(fs.paths.cache, "bundles", `${storyId}${BUNDLE_EXT}`);
      await fs.mkdirs(joinPath(fs.paths.cache, "bundles"));
      await exportBundle(
        fs,
        {
          ref: found.ref,
          manifestBytes: m.bytes,
          manifest: m.check.manifest,
          lists: app.lists,
          storage: await app.storageReceiptEvents(found.ref.storyId, found.ref.version),
          includeVideo,
          fetchFile: async (sha, info) => {
            const saved = await offline.lookup(sha);
            if (saved) return saved;
            if (info.kind === "video") return media.video({ sha256: sha, cid: info.cid! });
            return media.original({ sha256: sha, cid: info.cid });
          },
        },
        joinPath(fs.paths.cache, "bundle-work", storyId),
        out,
      );
      setZip(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startDirect = async () => {
    if (!zip) return;
    if (!(await requestP2pPermissions())) return Alert.alert(t("p2p.permission"));
    if (!(await NativeAzaadP2P.isSupported())) return Alert.alert(t("p2p.unsupported"));
    setDirect(true);
    await NativeAzaadP2P.start("send", zip);
  };

  return (
    <Screen title={t("share.title")}>
      <Txt style={{ marginBottom: space.m }}>{t("share.help")}</Txt>
      <Toggle
        label={t("share.includeVideo")}
        value={includeVideo}
        onChange={setIncludeVideo}
        help={t("share.includeVideoHelp")}
      />
      {!zip ? (
        <Button title={t("share.build")} busy={busy} onPress={() => void build()} />
      ) : (
        <Notice tone="ok">{t("share.ready")}</Notice>
      )}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {zip ? (
        <Section>
          <Button
            title={t("share.shareSheet")}
            onPress={() => void nativeDocuments.share(zip, BUNDLE_MIME, t("share.title"))}
          />
          <Button
            kind="secondary"
            title={t("share.saveFile")}
            onPress={() => void nativeDocuments.saveAs(zip, `${storyId}${BUNDLE_EXT}`, BUNDLE_MIME)}
          />
          <Button kind="secondary" title={t("p2p.send")} onPress={() => void startDirect()} />
        </Section>
      ) : null}
      {direct ? (
        <Section title={t("p2p.title")}>
          <Txt muted size={14}>
            {t("p2p.sendHelp")}
          </Txt>
          {transfer.status ? <Txt>{transfer.status === "sent" ? t("p2p.sent") : transfer.status}</Txt> : null}
          {transfer.progress !== null ? (
            <Txt>{t("p2p.progress", { percent: Math.round(transfer.progress * 100) })}</Txt>
          ) : null}
          {transfer.peers.map((p) => (
            <Card key={p.address} onPress={() => void NativeAzaadP2P.connect(p.address)}>
              <Txt bold>{p.name || p.address}</Txt>
              <Txt muted size={12}>
                {p.address}
              </Txt>
            </Card>
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

export function ReceiveScreen({ zipPath }: { zipPath?: string }) {
  const services = useServices();
  const { app, fs, offline, config } = services;
  const { t } = useI18n();
  const nav = useNav();
  const [result, setResult] = useState<VerifiedBundle | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);

  const verify = async (path: string) => {
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const b = await importBundle(fs, path, joinPath(fs.paths.cache, "bundle-in", String(Date.now())), {
        ownerPubkey: config.ownerPubkey,
        knownListEvents: [...app.listEvents.values()],
        firstSeen: app.firstSeen,
      });
      setResult(b);
    } catch (e) {
      setError(e instanceof BundleError ? `${t(e.key)} (${e.message})` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const transfer = usePeerTransfer(React.useCallback((p: string) => void verify(p), []));

  useEffect(() => {
    if (zipPath) void verify(zipPath);
  }, [zipPath]);

  const pick = async () => {
    const [doc] = await nativeDocuments.pick(["application/zip", "application/octet-stream"]);
    if (!doc) return;
    const dest = joinPath(fs.paths.cache, "bundle-pick.zip");
    await nativeDocuments.importUri(doc.uri, dest, 8 * 1024 * 1024 * 1024);
    await verify(dest);
  };

  const listen = async () => {
    if (!(await requestP2pPermissions())) return Alert.alert(t("p2p.permission"));
    if (!(await NativeAzaadP2P.isSupported())) return Alert.alert(t("p2p.unsupported"));
    setListening(true);
    await fs.mkdirs(joinPath(fs.paths.cache, "p2p-in"));
    await NativeAzaadP2P.start("receive", joinPath(fs.paths.cache, "p2p-in"));
  };

  const keep = async () => {
    if (!result) return;
    app.acceptListEvents(result.listEvents);
    app.addStoryEvents([result.ref.event]);
    await offline.saveBundle(result);
    nav.replace({ name: "story", storyId: result.ref.storyId, offline: true });
  };

  return (
    <Screen title={t("receive.title")}>
      <Txt style={{ marginBottom: space.m }}>{t("receive.help")}</Txt>
      <Button title={t("receive.pick")} onPress={() => void pick()} />
      <Button kind="secondary" title={t("p2p.receive")} onPress={() => void listen()} />
      {listening ? (
        <Section title={t("p2p.title")}>
          <Txt muted size={14}>
            {t("p2p.receiveHelp")}
          </Txt>
          {transfer.status ? <Txt>{transfer.status}</Txt> : null}
          {transfer.progress !== null ? (
            <Txt>{t("p2p.progress", { percent: Math.round(transfer.progress * 100) })}</Txt>
          ) : null}
          {transfer.peers.map((p) => (
            <Card key={p.address}>
              <Txt>{p.name || p.address}</Txt>
            </Card>
          ))}
        </Section>
      ) : null}
      {busy ? <Loading label={t("receive.verifying")} /> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {result ? (
        <Card>
          <Badge tone="ok" label={t("receive.verified")} />
          <Txt bold size={18} style={{ marginTop: space.s }}>
            {result.ref.title}
          </Txt>
          {result.unlisted ? <Notice>{t("story.unlistedNotice")}</Notice> : null}
          {result.missing.length ? (
            <Txt muted size={13}>
              {t("receive.missing", { count: result.missing.length })}
            </Txt>
          ) : null}
          <Button title={t("receive.keep")} onPress={() => void keep()} />
        </Card>
      ) : null}
    </Screen>
  );
}
