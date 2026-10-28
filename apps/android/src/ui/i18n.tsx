import { createTranslator, detectLanguage, formatDate, formatNumber } from "@azaadawaaz/core";
import type { Lang } from "@azaadawaaz/schema";
import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import en from "../i18n/en.json";
import hi from "../i18n/hi.json";
import type { JsonStore } from "../platform/kv";
import { fontFamily } from "./theme";

export const appMessages = { en, hi } as const;

export interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: string, vars?: Record<string, string | number>): string;
  date(d: Date | number | string, withTime?: boolean): string;
  num(n: number): string;
  font: string;
}

export function makeI18n(lang: Lang, setLang: (l: Lang) => void = () => {}): I18n {
  const t = createTranslator(lang, appMessages);
  return {
    lang,
    setLang,
    t,
    date: (d, withTime) => formatDate(d, lang, withTime),
    num: (n) => formatNumber(n, lang),
    font: fontFamily(lang),
  };
}

/** The phone's language (spec §13): Hindi if preferred, otherwise English. */
export function deviceLanguage(): Lang {
  try {
    return detectLanguage([Intl.DateTimeFormat().resolvedOptions().locale]);
  } catch {
    return "en";
  }
}

const Ctx = createContext<I18n>(makeI18n("en"));

export function I18nProvider({ children, store }: { children: ReactNode; store?: JsonStore }) {
  const [lang, setLangState] = useState<Lang>(deviceLanguage);
  useEffect(() => {
    void store?.get<Lang>("ui:lang").then((l) => {
      if (l === "en" || l === "hi") setLangState(l);
    });
  }, [store]);
  const value = useMemo(
    () =>
      makeI18n(lang, (l) => {
        setLangState(l);
        void store?.set("ui:lang", l);
      }),
    [lang, store],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
