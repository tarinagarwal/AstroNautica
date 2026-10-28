import { spawn, spawnSync } from "node:child_process";

/*
 * Media parsers are an attack surface (spec §12). ffmpeg and ffprobe run as separate processes:
 *   - started with an argument array (never through a shell), stdin closed, a minimal environment (no
 *     secrets from ours), in a working directory we choose;
 *   - under `prlimit` when it exists (util-linux): address-space, CPU-time, output-file-size, open-file and
 *     core-dump limits enforced by the kernel;
 *   - always with a wall-clock timeout (SIGKILL) and a cap on captured stdout/stderr.
 * The production container adds more (read-only root, no network, no capabilities, pids and memory limits;
 * see infra/prod/docker-compose.yml).
 */

export interface ToolLimits {
  /** Wall-clock limit; the process is killed with SIGKILL when it is exceeded. */
  timeoutMs: number;
  /** Maximum captured stdout; exceeding it kills the process. */
  maxStdoutBytes?: number;
  /** stderr beyond this is dropped (only the tail is kept for error messages). */
  maxStderrBytes?: number;
  /** RLIMIT_AS (virtual memory), bytes. */
  addressSpaceBytes?: number;
  /** RLIMIT_CPU, seconds of CPU time across all threads. */
  cpuSeconds?: number;
  /** RLIMIT_FSIZE: largest file the process may write, bytes. */
  maxFileBytes?: number;
  /** RLIMIT_NOFILE. */
  maxOpenFiles?: number;
  cwd?: string;
}

export interface ToolResult {
  stdout: string;
  stderr: string;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

let prlimitAvailable: boolean | undefined;

/** Whether `prlimit` is installed (checked once). */
export function hasPrlimit(): boolean {
  if (prlimitAvailable === undefined) {
    prlimitAvailable = spawnSync("prlimit", ["--version"], { stdio: "ignore" }).status === 0;
  }
  return prlimitAvailable;
}

/** The command line actually executed: `prlimit --as=… -- cmd args…` when prlimit exists. */
export function sandboxedCommand(cmd: string, args: readonly string[], limits: ToolLimits): [string, string[]] {
  if (!hasPrlimit()) return [cmd, [...args]];
  const rl: string[] = ["--core=0"];
  if (limits.addressSpaceBytes) rl.push(`--as=${limits.addressSpaceBytes}`);
  if (limits.cpuSeconds) rl.push(`--cpu=${Math.ceil(limits.cpuSeconds)}`);
  if (limits.maxFileBytes) rl.push(`--fsize=${limits.maxFileBytes}`);
  if (limits.maxOpenFiles) rl.push(`--nofile=${limits.maxOpenFiles}`);
  return ["prlimit", [...rl, "--", cmd, ...args]];
}

/** Runs a tool in the sandbox described above and resolves with its output, or rejects with ToolError. */
export function runTool(cmd: string, args: readonly string[], limits: ToolLimits): Promise<ToolResult> {
  const [exe, argv] = sandboxedCommand(cmd, args, limits);
  const maxStdout = limits.maxStdoutBytes ?? 16 * 1024 * 1024;
  const maxStderr = limits.maxStderrBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, {
      cwd: limits.cwd,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let failure: string | undefined;
    const kill = (why: string): void => {
      failure ??= why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill(`${cmd} timed out after ${limits.timeoutMs} ms`), limits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) kill(`${cmd} produced more than ${maxStdout} bytes of output`);
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-maxStderr);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError(`${cmd} could not start: ${e.message}`, err, null, null));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(new ToolError(failure, err, code, signal));
      else if (code !== 0) {
        const tail = err.trim().split("\n").slice(-5).join("\n");
        reject(new ToolError(`${cmd} failed (${signal ?? `exit ${code}`}): ${tail}`, err, code, signal));
      } else resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: err });
    });
  });
}
