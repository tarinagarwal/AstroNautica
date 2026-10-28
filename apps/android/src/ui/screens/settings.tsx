import { newestRelease, downloadRelease, UpdateError } from "../../update/selfUpdate";
import React, { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { validPin, type VaultState } from "../../security/keys";
import { secondsUntilRetry } from "../../security/lock";
import { nativeDocuments } from "../../platform/nativeFiles";
import { useObservable, useServices } from "../context";
import { useI18n } from "../i18n";
import { useNav, type Route } from "../nav";
import { space } from "../theme";
import { Badge, Button, Card, Choice, Field, Notice, Row, Screen, Section, Toggle, Txt } from "../components/basic";
import type { Bridges } from "../../net/netManager";

export function useVaultState(): [VaultState | null, () => void] {
  const { keys } = useServices();
  const [state, setState] = useState<VaultState | null>(null);
  const [n, setN] = useState(0);
  useObservable(keys);
  useEffect(() => {
    let live = true;
    keys.state().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [keys, n, keys.loaded]);
  return [state, () => setN((x) => x + 1)];
}

export function SettingsScreen() {
  const { net, app, keys } = useServices();
  const { t, lang, setLang } = useI18n();
  const nav = useNav();
  const [vault, refreshVault] = useVaultState();
  const [checking, setChecking] = useState(false);
  useObservable(net);
  const torLabel = t(`tor.state.${net.tor.state}`) + (net.tor.state === "starting" ? ` ${net.tor.bootstrap}%` : "");
  const check = async () => {
    setChecking(true);
    try {
      const switched = await net.checkAndMaybeEnableTor(
        app.relayUrls(),
        app.gateways.list().map((g) => ({ url: g.url, network: g.network })),
      );
      if (switched) Alert.alert(t("tor.autoOn"));
    } finally {
      setChecking(false);
    }
  };
  const lockRequired = keys.loaded && (!!keys.contributor() || !!keys.moderator());
  return (
    <Screen title={t("nav.settings")}>
      <Section title={t("lang.switch")}>
        <Choice
          value={lang}
          onChange={setLang}
          options={[
            { value: "en", label: t("lang.en") },
            { value: "hi", label: t("lang.hi") },
          ]}
        />
      </Section>
      <Section title={t("tor.title")}>
        <Toggle
          label={t("tor.useTor")}
          value={net.settings.torEnabled}
          onChange={(v) => void net.setTor(v)}
          help={t("tor.help")}
        />
        <Row style={{ marginBottom: space.m }}>
          <Badge
            tone={net.tor.state === "on" ? "ok" : net.tor.state === "error" ? "bad" : "neutral"}
            label={torLabel}
          />
          {net.tor.error ? (
            <Txt muted size={13}>
              {net.tor.error}
            </Txt>
          ) : null}
        </Row>
        <Txt muted size={14}>
          {t("tor.bridges")}
        </Txt>
        <Choice<Bridges>
          value={net.settings.bridges}
          onChange={(b) => void net.setBridges(b)}
          options={[
            { value: "snowflake", label: "Snowflake" },
            { value: "obfs4", label: "obfs4" },
            { value: "none", label: t("tor.noBridges") },
          ]}
        />
        <Toggle
          label={t("tor.auto")}
          value={net.settings.autoTor}
          onChange={(v) => void net.setAutoTor(v)}
          help={t("tor.autoHelp")}
        />
        <Button kind="secondary" busy={checking} title={t("net.check")} onPress={() => void check()} />
        {net.reachability ? (
          <Txt muted size={13}>
            {t("net.checkResult", {
              relays: net.reachability.relays.filter((r) => r.ok).length,
              relaysTotal: net.reachability.relays.length,
              gateways: net.reachability.gateways.filter((g) => g.ok).length,
              gatewaysTotal: net.reachability.gateways.length,
            })}
          </Txt>
        ) : null}
        <Notice tone="ok">{t("doh.help")}</Notice>
      </Section>
      <Section title={t("lock.title")}>
        {vault ? (
          <>
            <Txt>{vault.lock === "pin" ? t("lock.on") : t("lock.off")}</Txt>
            {lockRequired ? (
              <Txt muted size={13}>
                {t("lock.required")}
              </Txt>
            ) : null}
            {vault.lock === "none" ? (
              <Button title={t("lock.setPin")} onPress={() => nav.push({ name: "pinSetup" })} />
            ) : (
              <>
                <Button kind="secondary" title={t("lock.changePin")} onPress={() => nav.push({ name: "pinSetup" })} />
                {vault.biometricAvailable ? (
                  <Toggle
                    label={t("lock.biometric")}
                    value={vault.biometric}
                    onChange={async (v) => {
                      try {
                        if (v)
                          await keys.enableBiometric(
                            t("lock.biometricTitle"),
                            t("lock.biometricSubtitle"),
                            t("common.cancel"),
                          );
                        else await keys.disableBiometric();
                      } catch (e) {
                        Alert.alert(t("common.error"), String(e));
                      }
                      refreshVault();
                    }}
                  />
                ) : null}
                {!lockRequired ? (
                  <Button
                    kind="danger"
                    title={t("lock.remove")}
                    onPress={() =>
                      void keys.removePin().then(refreshVault, (e) => Alert.alert(t("common.error"), String(e)))
                    }
                  />
                ) : null}
              </>
            )}
          </>
        ) : null}
      </Section>
      <Section title={t("keys.title")}>
        <Button kind="secondary" title={t("keys.manage")} onPress={() => nav.push({ name: "keys" })} />
      </Section>
      <Section title={t("update.title")}>
        <Button kind="secondary" title={t("update.check")} onPress={() => nav.push({ name: "update" })} />
      </Section>
    </Screen>
  );
}

export function KeysScreen() {
  const { keys } = useServices();
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const [importText, setImportText] = useState("");
  useObservable(keys);
  useEffect(() => {
    nativeDocuments.setSecureScreen(true);
    return () => nativeDocuments.setSecureScreen(false);
  }, []);
  if (!keys.loaded)
    return (
      <Screen title={t("keys.title")}>
        <Notice>{t("keys.locked")}</Notice>
      </Screen>
    );
  const reader = keys.reader();
  const contributor = keys.contributor();
  const mod = keys.moderator();
  return (
    <Screen title={t("keys.title")}>
      <Section title={t("keys.reader")}>
        <Txt muted size={14}>
          {t("keys.backupHelp")}
        </Txt>
        {reader ? (
          <>
            <Txt selectable size={13}>
              {reader.npub}
            </Txt>
            {show ? (
              <Card>
                <Txt selectable size={13}>
                  {reader.nsec}
                </Txt>
              </Card>
            ) : null}
            <Button
              kind="secondary"
              title={show ? t("keys.hide") : t("keys.export")}
              onPress={() => setShow((s) => !s)}
            />
          </>
        ) : (
          <Txt muted>{t("keys.noReader")}</Txt>
        )}
        <Field
          label={t("keys.import")}
          value={importText}
          onChangeText={setImportText}
          autoCapitalize="none"
          secureTextEntry
        />
        <Button
          kind="secondary"
          title={t("keys.import")}
          disabled={!importText.trim()}
          onPress={() =>
            void keys.importReader(importText).then(
              () => setImportText(""),
              (e) => Alert.alert(t("common.error"), e instanceof Error ? e.message : String(e)),
            )
          }
        />
      </Section>
      {contributor ? (
        <Section title={t("keys.contributor")}>
          <Txt selectable size={13}>
            {contributor.npub}
          </Txt>
        </Section>
      ) : null}
      {mod ? (
        <Section title={t("keys.moderator")}>
          <Txt selectable size={13}>
            {mod.keys.npub}
          </Txt>
          <Txt muted size={12} selectable>
            X25519 {mod.x25519.publicKey}
          </Txt>
        </Section>
      ) : null}
      <Section title={t("keys.wipeTitle")}>
        <Button
          kind="danger"
          title={t("keys.wipe")}
          onPress={() =>
            Alert.alert(t("keys.wipeTitle"), t("keys.wipeBody"), [
              { text: t("common.cancel"), style: "cancel" },
              { text: t("keys.wipe"), style: "destructive", onPress: () => void keys.wipe() },
            ])
          }
        />
      </Section>
    </Screen>
  );
}

export function PinSetupScreen({ then }: { then?: Route }) {
  const { keys } = useServices();
  const { t } = useI18n();
  const nav = useNav();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = validPin(pin) && pin === again;
  const save = async () => {
    setBusy(true);
    try {
      await keys.setPin(pin);
      if (!keys.loaded) await keys.load();
      if (then) nav.replace(then);
      else nav.back();
    } catch (e) {
      Alert.alert(t("common.error"), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t("lock.setPin")}>
      <Txt style={{ marginBottom: space.m }}>{t("lock.pinHelp")}</Txt>
      <Field
        label={t("lock.pin")}
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={12}
      />
      <Field
        label={t("lock.pinAgain")}
        value={again}
        onChangeText={setAgain}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={12}
      />
      {again && pin !== again ? <Txt muted>{t("lock.pinMismatch")}</Txt> : null}
      <Button title={t("common.save")} disabled={!ok} busy={busy} onPress={() => void save()} />
    </Screen>
  );
}

/** Shown at start and after the app was in the background, when an app lock is set. */
export function LockScreen({ onUnlocked, vault }: { onUnlocked: () => void; vault: VaultState }) {
  const { keys } = useServices();
  const { t } = useI18n();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const wait = secondsUntilRetry(vault.retryAt);
  const unlockPin = async () => {
    setBusy(true);
    try {
      const r = await keys.unlockWithPin(pin);
      if (r.ok) {
        await keys.load();
        onUnlocked();
      } else {
        setPin("");
        setError(
          r.retryAt > Date.now()
            ? t("lock.wait", { seconds: secondsUntilRetry(r.retryAt) })
            : t("lock.wrong", { left: r.attemptsLeft }),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const unlockBio = async () => {
    try {
      if (await keys.unlockWithBiometric(t("lock.biometricTitle"), t("lock.biometricSubtitle"), t("common.cancel"))) {
        await keys.load();
        onUnlocked();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (vault.biometric) void unlockBio();
  }, []);
  return (
    <Screen title={t("lock.locked")}>
      <Txt style={{ marginBottom: space.l }}>{t("lock.enterPin")}</Txt>
      <Field
        label={t("lock.pin")}
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={12}
        onSubmitEditing={() => void unlockPin()}
      />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {wait > 0 ? <Txt muted>{t("lock.wait", { seconds: wait })}</Txt> : null}
      <Button title={t("lock.unlock")} disabled={pin.length < 6} busy={busy} onPress={() => void unlockPin()} />
      {vault.biometric ? (
        <Button kind="secondary" title={t("lock.useBiometric")} onPress={() => void unlockBio()} />
      ) : null}
      <View style={{ height: space.xl }} />
      <Txt muted size={13}>
        {t("lock.readerNote")}
      </Txt>
    </Screen>
  );
}

export function UpdateScreen() {
  const services = useServices();
  const { app, installed } = services;
  const { t, lang } = useI18n();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState<string>();
  useObservable(app);
  const release = newestRelease(app.lists?.releases ?? [], installed);
  const download = async () => {
    if (!release) return;
    setError(undefined);
    setProgress(0);
    try {
      const path = await downloadRelease({
        release,
        installed,
        http: services.http,
        fs: services.fs,
        inspector: services.inspector,
        onProgress: (b, total) => setProgress(total > 0 ? b / total : 0),
      });
      setReady(path);
    } catch (e) {
      setError(e instanceof UpdateError ? t(e.key) + ` (${e.message})` : e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };
  const install = async () => {
    if (!ready) return;
    if (!(await services.canInstall())) {
      Alert.alert(t("update.permissionTitle"), t("update.permissionBody"), [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("update.openSettings"), onPress: () => void services.openInstallSettings() },
      ]);
      return;
    }
    await services.install(ready);
  };
  return (
    <Screen title={t("update.title")}>
      <Txt>{t("update.installed", { version: installed.versionName, code: installed.versionCode })}</Txt>
      {!release ? <Notice tone="ok">{t("update.none")}</Notice> : null}
      {release ? (
        <Card>
          <Txt bold>{t("update.available", { version: release.version })}</Txt>
          {release.notes ? <Txt>{release.notes[lang] ?? release.notes.en ?? release.notes.hi ?? ""}</Txt> : null}
          <Txt muted size={12} selectable>
            SHA-256 {release.sha256}
          </Txt>
          <Txt muted size={12} selectable>
            {t("update.cert")} {release.signingCertSha256}
          </Txt>
          {progress !== null ? <Txt>{t("update.downloading", { percent: Math.round(progress * 100) })}</Txt> : null}
          {ready ? <Notice tone="ok">{t("update.verified")}</Notice> : null}
          {error ? <Notice tone="bad">{error}</Notice> : null}
          {ready ? (
            <Button title={t("update.install")} onPress={() => void install()} />
          ) : (
            <Button title={t("update.download")} busy={progress !== null} onPress={() => void download()} />
          )}
        </Card>
      ) : null}
    </Screen>
  );
}
