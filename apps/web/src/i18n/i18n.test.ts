import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { coreMessages } from "@core/i18n.js";
import en from "./en.json";
import hi from "./hi.json";
import { makeI18n } from "./index.js";

const SRC = join(__dirname, "..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "test" ? [] : files(p, ext);
    return ext.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  it("English and Hindi have exactly the same keys (app and core)", () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(coreMessages.hi).sort()).toEqual(Object.keys(coreMessages.en).sort());
  });

  it("translations keep the same {placeholders} and are not left empty", () => {
    for (const [k, v] of Object.entries(en)) {
      expect(placeholders((hi as Record<string, string>)[k]!), k).toEqual(placeholders(v));
      expect(v.trim(), k).not.toBe("");
      expect((hi as Record<string, string>)[k]!.trim(), k).not.toBe("");
    }
  });

  it("Hindi strings are written in Devanagari (not copied English)", () => {
    const latinOnly = Object.entries(hi).filter(
      ([k, v]) => !/[ऀ-ॿ]/.test(v) && v !== (en as Record<string, string>)[k],
    );
    expect(latinOnly).toEqual([]);
    const copied = Object.entries(hi).filter(
      ([k, v]) => v === (en as Record<string, string>)[k] && /[a-z]{4}/i.test(v.replace(/\{\w+\}/g, "")),
    );
    // Only proper nouns and formats may be identical.
    expect(
      copied.map(([k]) => k).filter((k) => !["verify.ipfs", "verify.arweave", "lang.en", "lang.hi"].includes(k)),
    ).toEqual([]);
  });

  it("every key used in the code exists", () => {
    const table = { ...coreMessages.en, ...en } as Record<string, string>;
    const missing: string[] = [];
    for (const f of files(SRC, /\.(ts|tsx)$/)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\("([^"]+)"/g))
        if (!(m[1]! in table)) missing.push(`${relative(SRC, f)}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it("components contain no hard-coded user-facing text", () => {
    const offenders: string[] = [];
    const letters = /\p{L}/u;
    const textAttrs = new Set(["alt", "title", "placeholder", "aria-label", "label"]);
    for (const f of files(SRC, /\.tsx$/)) {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const where = (n: ts.Node) => `${relative(SRC, f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      const visit = (n: ts.Node) => {
        if (ts.isJsxText(n) && letters.test(n.text)) offenders.push(`${where(n)} text "${n.text.trim()}"`);
        if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer)) {
          const name = n.name.getText(sf);
          if (textAttrs.has(name) && letters.test(n.initializer.text))
            offenders.push(`${where(n)} ${name}="${n.initializer.text}"`);
        }
        if (
          ts.isJsxExpression(n) &&
          n.expression &&
          ts.isStringLiteral(n.expression) &&
          ts.isJsxElement(n.parent) &&
          letters.test(n.expression.text)
        )
          offenders.push(`${where(n)} {"${n.expression.text}"}`);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });

  it("app strings override core and missing keys fall back visibly", () => {
    const t = makeI18n("hi").t;
    expect(t("nav.home")).toBe("मुखपृष्ठ");
    expect(t("home.latest")).toBe("ताज़ा कहानियाँ");
    expect(t("no.such.key")).toBe("no.such.key");
    expect(makeI18n("en").t("comments.chars", { count: 1200, max: 2000 })).toBe("1,200 / 2,000");
  });
});
