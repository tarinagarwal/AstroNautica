import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { coreMessages } from "@azaadawaaz/core";
import en from "../../i18n/en.json";
import hi from "../../i18n/hi.json";

const SRC = resolve(__dirname, "../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "__tests__" || n === "test") return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("English and Hindi strings", () => {
  it("have the same keys and placeholders", () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect([k, ph((hi as Record<string, string>)[k]!)]).toEqual([k, ph(v)]);
      expect((hi as Record<string, string>)[k]!.trim()).not.toBe("");
    }
  });

  it("use Devanagari for Hindi", () => {
    const deva = Object.values(hi).filter((v) => /[ऀ-ॿ]/.test(v)).length;
    expect(deva / Object.keys(hi).length).toBeGreaterThan(0.9);
  });

  it("cover every key the code uses (no hard-coded UI text without a translation)", () => {
    const known = new Set([...Object.keys(en), ...Object.keys(coreMessages.en)]);
    const missing: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\bt\(\s*"([a-z][\w.-]+)"/g)) if (!known.has(m[1]!)) missing.push(`${f}: ${m[1]}`);
      for (const m of text.matchAll(/new (?:Media|Bundle|Update)Error\(\s*"([\w.-]+)"/g)) if (!known.has(m[1]!)) missing.push(`${f}: ${m[1]}`);
      for (const m of text.matchAll(/key: "([a-z][\w.-]+)"/g)) if (m[1]!.includes(".") && !known.has(m[1]!)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
    // keys built at run time
    for (const p of ["submission.state.", "tor.state.", "verify.chainError.", "verify.arweave.", "editor.block.", "moderate.confirm.", "moderate.confirmBody."])
      expect(Object.keys(en).some((k) => k.startsWith(p))).toBe(true);
    for (const s of ["draft", "submitted", "in_review", "changes_requested", "rejected", "approved", "publishing", "published", "unlisted"])
      expect(known.has(`submission.state.${s}`)).toBe(true);
    for (const s of ["not-found", "mismatch", "unreachable", "not-publisher"]) expect(known.has(`verify.chainError.${s}`)).toBe(true);
  });
});
