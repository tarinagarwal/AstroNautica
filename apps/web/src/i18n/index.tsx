import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createTranslator, detectLanguage, formatDate, formatNumber } from "@core/i18n.js";
import type { Lang } from "@azaadawaaz/schema";
import en from "./en.json";
import hi from "./hi.json";

export const appMessages = { en, hi } as const;

export interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: string, vars?: Record<string, string | number>): string;
  date(d: Date | number | string, withTime?: boolean): string;
  num(n: number): string;
}

const LANG_KEY = "azaad:lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "hi") return saved;
  } catch {
    // storage blocked
  }
  return detectLanguage(typeof navigator !== "undefined" ? navigator.languages : undefined);
}

export function makeI18n(lang: Lang, setLang: (l: Lang) => void = () => {}): I18n {
  const t = createTranslator(lang, appMessages);
  return {
    lang,
    setLang,
    t,
    date: (d, withTime) => formatDate(d, lang, withTime),
    num: (n) => formatNumber(n, lang),
  };
}

const Ctx = createContext<I18n>(makeI18n("en"));

export function I18nProvider({ children, lang: forced }: { children: ReactNode; lang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(forced ?? initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(
    () =>
      makeI18n(lang, (l) => {
        try {
          localStorage.setItem(LANG_KEY, l);
        } catch {
          // storage blocked
        }
        setLangState(l);
      }),
    [lang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;
