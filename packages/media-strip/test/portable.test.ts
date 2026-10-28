import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("portability", () => {
  it("uses no Node-only APIs, so it runs in browsers and React Native", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const file of readdirSync(dir)) {
      const src = readFileSync(new URL(file, dir), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, file).not.toMatch(/\bBuffer\b|from "node:|require\(|\bprocess\.|TextDecoder/);
    }
  });
});
