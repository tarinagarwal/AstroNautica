import { lazy, Suspense, type ReactNode } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { I18nProvider, useT } from "./i18n/index.js";
import { DataProvider } from "./data/context.js";
import { SessionProvider } from "./data/session.js";
import type { AppData } from "./data/appData.js";
import { Layout } from "./components/Layout.js";
import { Home } from "./pages/Home.js";

const StoryPage = lazy(() => import("./pages/StoryPage.js"));
const VersionPage = lazy(() => import("./pages/VersionPage.js"));
const TagPage = lazy(() => import("./pages/TagPage.js"));
const SearchPage = lazy(() => import("./pages/SearchPage.js"));
const AboutPage = lazy(() => import("./pages/AboutPage.js"));
const ReachPage = lazy(() => import("./pages/ReachPage.js"));
const KeyPage = lazy(() => import("./pages/KeyPage.js"));
const InvitePage = lazy(() => import("./pages/contributor/InvitePage.js"));
const ContributorArea = lazy(() => import("./pages/contributor/ContributorArea.js"));
const ModeratorArea = lazy(() => import("./pages/moderator/ModeratorArea.js"));

function Loading() {
  const t = useT();
  return <p className="muted pad">{t("common.loading")}</p>;
}

function NotFound() {
  const t = useT();
  return <p className="pad">{t("page.notFound")}</p>;
}

const L = ({ children }: { children: ReactNode }) => <Suspense fallback={<Loading />}>{children}</Suspense>;

export function App({ app, autoRefresh = true }: { app: AppData; autoRefresh?: boolean }) {
  return (
    <I18nProvider>
      <DataProvider app={app} autoRefresh={autoRefresh}>
        <SessionProvider>
          <HashRouter>
            <Layout>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/story/:id" element={<L><StoryPage /></L>} />
                <Route path="/story/:id/version/:sha" element={<L><VersionPage /></L>} />
                <Route path="/tag/:tag" element={<L><TagPage /></L>} />
                <Route path="/search" element={<L><SearchPage /></L>} />
                <Route path="/about" element={<L><AboutPage /></L>} />
                <Route path="/reach" element={<L><ReachPage /></L>} />
                <Route path="/key" element={<L><KeyPage /></L>} />
                <Route path="/invite/:code" element={<L><InvitePage /></L>} />
                <Route path="/contribute/*" element={<L><ContributorArea /></L>} />
                <Route path="/moderate/*" element={<L><ModeratorArea /></L>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Layout>
          </HashRouter>
        </SessionProvider>
      </DataProvider>
    </I18nProvider>
  );
}
