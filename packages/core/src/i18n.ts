import type { Lang, LocalizedText, StoryLanguage } from "@azaadawaaz/schema";
import en from "./i18n/en.json" with { type: "json" };
import hi from "./i18n/hi.json" with { type: "json" };

export type Messages = Record<string, string>;
export const coreMessages: Record<Lang, Messages> = { en, hi };

/** Pick the UI language from the browser or phone languages; Hindi if preferred, otherwise English (spec §13). */
export function detectLanguage(preferred: readonly string[] | undefined): Lang {
  for (const l of preferred ?? []) {
    const base = l.toLowerCase().split("-")[0];
    if (base === "hi") return "hi";
    if (base === "en") return "en";
  }
  return "en";
}

/**
 * Create a translator. App-specific messages are merged over the core ones. A missing key falls back to English,
 * then to the key itself, so a gap is visible rather than blank.
 */
export function createTranslator(lang: Lang, extra: Partial<Record<Lang, Messages>> = {}) {
  const table = { ...coreMessages.en, ...extra.en, ...(lang === "hi" ? { ...coreMessages.hi, ...extra.hi } : {}) };
  return (key: string, vars?: Record<string, string | number>): string => {
    const s = table[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? formatVar(vars[k]!, lang) : m)) : s;
  };
}

function formatVar(v: string | number, lang: Lang): string {
  return typeof v === "number" ? formatNumber(v, lang) : v;
}

const locale = (lang: Lang) => (lang === "hi" ? "hi-IN" : "en-IN");

export function formatNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(locale(lang)).format(n);
}

export function formatDate(d: Date | number | string, lang: Lang, withTime = false): string {
  const date = d instanceof Date ? d : new Date(typeof d === "number" && d < 1e12 ? d * 1000 : d);
  return new Intl.DateTimeFormat(locale(lang), {
    dateStyle: "long",
    ...(withTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

/** The languages a story can be read in. */
export function storyLanguages(language: StoryLanguage): Lang[] {
  return language === "both" ? ["en", "hi"] : [language];
}

/** Text for the reader's language, falling back to whichever the story has. */
export function pickText(t: LocalizedText | undefined, lang: Lang): string {
  if (!t) return "";
  return t[lang] ?? t.en ?? t.hi ?? "";
}

/** The language a story should open in for this reader. */
export function defaultStoryLang(language: StoryLanguage, uiLang: Lang): Lang {
  return language === "both" ? uiLang : language;
}
