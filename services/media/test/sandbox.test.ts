import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasPrlimit, runTool, ToolError } from "../src/index.js";
import { sandboxedCommand } from "../src/sandbox.js";
import { HAS_FFMPEG, tempDir } from "./helpers.js";

describe("sandboxed tools", () => {
  it("passes arguments as an array, never through a shell", async () => {
    const { stdout } = await runTool("printf", ["%s|", "a b", "$(id)", "; rm -rf /"], { timeoutMs: 5000 });
    expect(stdout).toBe("a b|$(id)|; rm -rf /|");
  });

  it("gives the tool a minimal environment", async () => {
    process.env.AZAAD_TEST_SECRET = "hunter2";
    try {
      const { stdout } = await runTool("env", [], { timeoutMs: 5000 });
      expect(stdout).not.toContain("hunter2");
      expect(stdout).toContain("PATH=");
    } finally {
      delete process.env.AZAAD_TEST_SECRET;
    }
  });

  it("kills a tool that runs past its timeout", async () => {
    const started = Date.now();
    await expect(runTool("sleep", ["10"], { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("kills a tool that floods stdout", async () => {
    await expect(runTool("yes", [], { timeoutMs: 5000, maxStdoutBytes: 10_000 })).rejects.toThrow(/more than 10000/);
  });

  it("reports a failing tool with the tail of its stderr", async () => {
    const err = await runTool("ls", ["/definitely/not/here"], { timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/exit 2|No such file/);
  });

  it.skipIf(!hasPrlimit())("wraps tools in prlimit with kernel-enforced limits", async () => {
    const [cmd, args] = sandboxedCommand("ffmpeg", ["-version"], {
      timeoutMs: 1000,
      addressSpaceBytes: 1 << 30,
      cpuSeconds: 10.2,
      maxFileBytes: 1 << 20,
      maxOpenFiles: 64,
    });
    expect(cmd).toBe("prlimit");
    expect(args).toEqual([
      "--core=0",
      `--as=${1 << 30}`,
      "--cpu=11",
      `--fsize=${1 << 20}`,
      "--nofile=64",
      "--",
      "ffmpeg",
      "-version",
    ]);
    // The limit really applies: a 1 MiB file-size limit stops a writer at 1 MiB.
    await expect(
      runTool("dd", ["if=/dev/zero", "of=/dev/null", "bs=1k", "count=1"], { timeoutMs: 5000, maxFileBytes: 1 << 20 }),
    ).resolves.toBeDefined();
    const dir = tempDir();
    try {
      await expect(
        runTool("sh", ["-c", 'head -c 2000000 /dev/zero > "$0"', join(dir, "big")], {
          timeoutMs: 5000,
          maxFileBytes: 1 << 20,
        }),
      ).rejects.toThrow(ToolError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasPrlimit() || !HAS_FFMPEG)("an address-space limit stops ffmpeg", async () => {
    await expect(runTool("ffmpeg", ["-version"], { timeoutMs: 10_000, addressSpaceBytes: 8 << 20 })).rejects.toThrow(
      ToolError,
    );
    await expect(
      runTool("ffmpeg", ["-version"], { timeoutMs: 10_000, addressSpaceBytes: 2 * 1024 ** 3 }),
    ).resolves.toBeDefined();
  });
});
