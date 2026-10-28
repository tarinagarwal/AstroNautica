import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, insideShared } from "../src/server.js";

describe("media worker path containment", () => {
  const shared = mkdtempSync(join(tmpdir(), "media-shared-"));

  it("accepts paths inside the shared directory", () => {
    expect(insideShared("job/src/a", shared)).toBe(join(shared, "job/src/a"));
  });

  it("rejects escapes, absolute paths and junk", () => {
    for (const bad of ["../etc/passwd", "/etc/passwd", "a/../../x", "", "a\0b", 42]) {
      expect(() => insideShared(bad as never, shared)).toThrow();
    }
  });

  it("rejects a symlink inside the shared directory that points outside it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "media-outside-"));
    writeFileSync(join(outside, "secret"), "nsec1...");
    mkdirSync(join(shared, "job"), { recursive: true });
    symlinkSync(join(outside, "secret"), join(shared, "job", "link"));
    await expect(handle({ kind: "image", input: "job/link", outDir: "job/out" }, shared)).rejects.toThrow(/escapes/);
  });

  it("rejects unknown kinds", async () => {
    writeFileSync(join(shared, "job", "x"), "x");
    await expect(handle({ kind: "pdf", input: "job/x", outDir: "job/o" }, shared)).rejects.toThrow(/kind/);
  });
});
