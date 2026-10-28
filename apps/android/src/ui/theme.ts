import type { Lang } from "@azaadawaaz/schema";

export const colors = {
  bg: "#fbfaf7",
  card: "#ffffff",
  text: "#1b1b1f",
  muted: "#5c5c66",
  border: "#e3e1dc",
  primary: "#b3261e",
  primaryText: "#ffffff",
  ok: "#1e7a3c",
  okBg: "#e6f4ea",
  bad: "#b3261e",
  badBg: "#fce8e6",
  warnBg: "#fff4e0",
  link: "#0b57d0",
  code: "#f1efe9",
};

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };

/** Bundled Noto fonts (android/app/src/main/assets/fonts); Devanagari also covers Latin text. */
export function fontFamily(lang: Lang): string {
  return lang === "hi" ? "NotoSansDevanagari" : "NotoSans";
}

/** Pick a font from the text itself, for mixed content (comments, user input). */
export function fontForText(text: string, fallback: Lang): string {
  return /[ऀ-ॿ]/.test(text) ? "NotoSansDevanagari" : fontFamily(fallback);
}
