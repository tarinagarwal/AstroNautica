import React, { useEffect, useRef, useState } from "react";
import { AppState, Linking, StatusBar, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { extractInviteCode } from "./contributor/invite";
import { nativeDocuments } from "./platform/nativeFiles";
import { onNativeEvent } from "./platform/nativeEvents";
import { joinPath } from "./platform/types";
import type { VaultState } from "./security/keys";
import { mustLockOnResume } from "./security/lock";
import { createServices, type Services } from "./services";
import { Loading } from "./ui/components/basic";
import { ServicesProvider, useServices } from "./ui/context";
import { I18nProvider } from "./ui/i18n";
import { NavProvider, useNav, type Route } from "./ui/nav";
import { colors } from "./ui/theme";
import { ContributeScreen, EditorScreen, InviteScreen } from "./ui/screens/contributor";
import { ModerateScreen, ReviewScreen } from "./ui/screens/moderator";
import { ReceiveScreen, SavedScreen, ShareScreen } from "./ui/screens/offline";
import { AboutScreen, HomeScreen, MenuScreen, ReachScreen, SearchScreen, StoryScreen, TagScreen } from "./ui/screens/reader";
import { KeysScreen, LockScreen, PinSetupScreen, SettingsScreen, UpdateScreen } from "./ui/screens/settings";

function CurrentScreen() {
  const { route } = useNav();
  switch (route.name) {
    case "home":
      return <HomeScreen />;
    case "story":
      return <StoryScreen storyId={route.storyId} offline={route.offline} />;
    case "verify":
      return <StoryScreen storyId={route.storyId} />;
    case "tag":
      return <TagScreen tag={route.tag} />;
    case "search":
      return <SearchScreen />;
    case "reach":
      return <ReachScreen />;
    case "about":
      return <AboutScreen />;
    case "menu":
      return <MenuScreen />;
    case "settings":
      return <SettingsScreen />;
    case "keys":
      return <KeysScreen />;
    case "saved":
      return <SavedScreen />;
    case "share":
      return <ShareScreen storyId={route.storyId} />;
    case "receive":
      return <ReceiveScreen zipPath={route.zipPath} />;
    case "update":
      return <UpdateScreen />;
    case "pinSetup":
      return <PinSetupScreen then={route.then} />;
    case "contribute":
      return <ContributeScreen />;
    case "invite":
      return <InviteScreen link={route.link} />;
    case "editor":
      return <EditorScreen draftId={route.draftId} />;
    case "moderate":
      return <ModerateScreen />;
    case "review":
      return <ReviewScreen submissionId={route.submissionId} />;
  }
}

/** Opens invite links (azaadawaaz://invite/…, https://…/#/invite/…) and story bundles shared to the app. */
function useIncoming(services: Services) {
  const nav = useNav();
  useEffect(() => {
    const handleUrl = (url: string | null | undefined) => {
      if (!url) return;
      if (extractInviteCode(url)) nav.push({ name: "invite", link: url });
      const story = url.match(/(?:azaadawaaz:\/\/story\/|#\/story\/)([0-9a-f-]{36})/);
      if (story) nav.push({ name: "story", storyId: story[1]! });
    };
    const handleIntent = async () => {
      const intent = await nativeDocuments.takePendingIntent();
      if (!intent) return;
      if (intent.uri.startsWith("content:") || intent.uri.startsWith("file:")) {
        const dest = joinPath(services.fs.paths.cache, `incoming-${Date.now()}.zip`);
        await nativeDocuments.importUri(intent.uri, dest, 8 * 1024 * 1024 * 1024);
        nav.push({ name: "receive", zipPath: dest });
      } else handleUrl(intent.uri);
    };
    void Linking.getInitialURL().then(handleUrl);
    void handleIntent();
    const sub = Linking.addEventListener("url", (e) => handleUrl(e.url));
    const off = onNativeEvent("azaadIntent", () => void handleIntent());
    return () => {
      sub.remove();
      off();
    };
  }, [nav, services]);
}

function Shell() {
  const services = useServices();
  useIncoming(services);
  return <CurrentScreen />;
}

/** Start-up: cached data first, then the network; the vault is opened (or the lock screen shown) before anything else. */
function Gate({ services }: { services: Services }) {
  const [vault, setVault] = useState<VaultState | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      await services.app.init();
      await services.net.init();
      const v = await services.keys.state();
      setVault(v);
      if (v.lock === "none") {
        await services.keys.load();
        setUnlocked(true);
      }
      await services.app.refresh().catch(() => undefined);
      if (services.app.relaysUnreachable) {
        await services.net.checkAndMaybeEnableTor(
          services.app.relayUrls(),
          services.app.gateways.list().map((g) => ({ url: g.url, network: g.network })),
        );
        if (services.net.settings.torEnabled) await services.app.refresh().catch(() => undefined);
      }
    })();
  }, [services]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if (state === "background") backgroundedAt.current = Date.now();
      if (state === "active") {
        const v = await services.keys.state();
        if (mustLockOnResume(backgroundedAt.current, Date.now(), v.lock === "pin")) {
          services.keys.lock();
          setVault(await services.keys.state());
          setUnlocked(false);
        }
        backgroundedAt.current = null;
      }
    });
    return () => sub.remove();
  }, [services]);

  if (!vault) return <Loading />;
  if (vault.lock === "pin" && !unlocked)
    return (
      <NavProvider>
        <LockScreen vault={vault} onUnlocked={() => setUnlocked(true)} />
      </NavProvider>
    );
  return (
    <NavProvider initial={{ name: "home" } as Route}>
      <Shell />
    </NavProvider>
  );
}

let singleton: Services | undefined;

export default function App() {
  const [services] = useState(() => (singleton ??= createServices()));
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <ServicesProvider services={services}>
        <I18nProvider store={services.settings}>
          <View style={{ flex: 1, backgroundColor: colors.bg }}>
            <Gate services={services} />
          </View>
        </I18nProvider>
      </ServicesProvider>
    </SafeAreaProvider>
  );
}
