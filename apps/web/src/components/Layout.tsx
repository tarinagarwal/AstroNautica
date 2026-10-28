import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useI18n } from "../i18n/index.js";
import { useApp } from "../data/context.js";

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t("lang.switch")}>
      <button
        type="button"
        className={lang === "en" ? "on" : ""}
        aria-pressed={lang === "en"}
        onClick={() => setLang("en")}
      >
        {t("lang.en")}
      </button>
      <button
        type="button"
        className={lang === "hi" ? "on" : ""}
        aria-pressed={lang === "hi"}
        onClick={() => setLang("hi")}
      >
        {t("lang.hi")}
      </button>
    </div>
  );
}

function Banners() {
  const app = useApp();
  const { t } = useI18n();
  return (
    <>
      {app.listsStatus === "none" && (
        <div className="banner warn" role="status" data-testid="no-lists">
          <strong>{t("banner.noLists")}</strong> {t("banner.noListsHelp")} <Link to="/reach">{t("nav.reach")}</Link>
        </div>
      )}
      {app.offline && app.listsStatus !== "none" && (
        <div className="banner" role="status">
          {t("error.offline")}
        </div>
      )}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <Link to="/" className="brand">
            {t("app.name")}
          </Link>
          <LangSwitch />
        </div>
        <nav className="nav" aria-label={t("nav.main")}>
          <NavLink to="/" end>
            {t("nav.home")}
          </NavLink>
          <NavLink to="/search">{t("nav.search")}</NavLink>
          <NavLink to="/reach">{t("nav.reach")}</NavLink>
          <NavLink to="/about">{t("nav.about")}</NavLink>
          <NavLink to="/contribute">{t("nav.contribute")}</NavLink>
          <NavLink to="/moderate">{t("nav.moderate")}</NavLink>
        </nav>
      </header>
      <Banners />
      <main className="main">{children}</main>
      <footer className="footer">
        <p>{t("app.tagline")}</p>
        <p>
          <Link to="/reach">{t("nav.reach")}</Link> · <Link to="/key">{t("nav.key")}</Link> ·{" "}
          <Link to="/about">{t("nav.about")}</Link>
        </p>
      </footer>
    </div>
  );
}
