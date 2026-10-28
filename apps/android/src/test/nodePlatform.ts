/**
 * Node implementations of the platform interfaces, used by the Jest tests: files on a temporary directory (zip via
 * fflate, with the same path-safety rules as the Kotlin BundleZip), HTTP through Node's fetch.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { FilePatch, FileSystem, Http, HttpResponse, ZipEntry } from "../platform/types";
import { HttpError } from "../platform/types";

export function tempDir(prefix = "azaad-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function nodeFs(root = tempDir()): FileSystem {
  const files = path.join(root, "files");
  const cache = path.join(root, "cache");
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const walk = (dir: string, base = dir): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join("/")];
    });
  return {
    paths: { files, cache },
    async writeBytes(p, data, append = false) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (append) fs.appendFileSync(p, data);
      else fs.writeFileSync(p, data);
    },
    async readBytes(p, offset = 0, length = -1) {
      const buf = fs.readFileSync(p);
      const end = length < 0 ? buf.length : Math.min(buf.length, offset + length);
      return new Uint8Array(buf.subarray(offset, end));
    },
    async writeText(p, text) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    },
    async readText(p) {
      return fs.readFileSync(p, "utf8");
    },
    async stat(p) {
      try {
        const s = fs.statSync(p);
        return { exists: true, size: s.isFile() ? s.size : 0, isDir: s.isDirectory(), mtime: s.mtimeMs };
      } catch {
        return { exists: false, size: 0, isDir: false, mtime: 0 };
      }
    },
    async remove(p) {
      fs.rmSync(p, { recursive: true, force: true });
    },
    async mkdirs(p) {
      fs.mkdirSync(p, { recursive: true });
    },
    async list(p) {
      return fs.readdirSync(p).sort();
    },
    async move(a, b) {
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.rmSync(b, { recursive: true, force: true });
      fs.renameSync(a, b);
    },
    async copy(a, b) {
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(a, b);
    },
    async sha256(p) {
      return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    },
    async patch(src: string, dest: string, patches: FilePatch[], truncate?: number) {
      const buf = Buffer.from(fs.readFileSync(src));
      for (const p of patches) {
        const len = p.zero ?? p.data.length;
        if (p.offset < 0 || p.offset + len > buf.length) throw new Error("patch outside the file");
        if (p.zero) buf.fill(0, p.offset, p.offset + p.zero);
        else buf.set(p.data, p.offset);
      }
      fs.writeFileSync(dest, truncate !== undefined ? buf.subarray(0, truncate) : buf);
    },
    async zipDir(dir, out) {
      const entries: Record<string, Uint8Array> = {};
      for (const rel of walk(dir)) entries[rel] = new Uint8Array(fs.readFileSync(path.join(dir, rel)));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, zipSync(entries, { level: 1 }));
    },
    async unzip(zip, destDir, limits): Promise<ZipEntry[]> {
      const data = unzipSync(new Uint8Array(fs.readFileSync(zip)));
      const names = Object.keys(data);
      if (names.length > limits.maxEntries) throw new Error("too many entries");
      let total = 0;
      const root = path.resolve(destDir);
      const out: ZipEntry[] = [];
      for (const name of names) {
        if (
          !name ||
          name.startsWith("/") ||
          name.includes("\\") ||
          name.split("/").some((s) => s === ".." || s === ".")
        )
          throw new Error(`unsafe entry name: ${name}`);
        const target = path.resolve(root, name);
        if (!target.startsWith(root + path.sep)) throw new Error(`entry escapes the destination: ${name}`);
        total += data[name]!.length;
        if (total > limits.maxBytes) throw new Error("bundle too large");
        if (name.endsWith("/")) {
          fs.mkdirSync(target, { recursive: true });
          out.push({ name, size: 0 });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data[name]!);
        out.push({ name, size: data[name]!.length });
      }
      return out;
    },
  };
}

export type Handler = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}) =>
  | { status?: number; body?: Uint8Array | string; headers?: Record<string, string> }
  | Promise<{ status?: number; body?: Uint8Array | string; headers?: Record<string, string> }>;

/** An in-process HTTP stack for tests: routes requests to a handler (no sockets), with download/upload semantics. */
export function fakeHttp(
  handler: Handler,
  fsImpl?: FileSystem,
): Http & { requests: { url: string; method: string }[] } {
  const requests: { url: string; method: string }[] = [];
  const run = async (
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<HttpResponse> => {
    requests.push({ url, method });
    const r = await handler({ url, method, headers, body });
    const b =
      r.body === undefined ? new Uint8Array(0) : typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body;
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: b, url };
  };
  return {
    requests,
    async request(req) {
      if (req.signal?.aborted) throw new HttpError("aborted", "aborted");
      const body = typeof req.body === "string" ? new TextEncoder().encode(req.body) : req.body;
      const res = await run(req.url, req.method ?? "GET", req.headers ?? {}, body);
      if (req.maxBytes !== undefined && res.body.length > req.maxBytes) throw new HttpError("too large", "too-large");
      return res;
    },
    async download(req) {
      const res = await run(req.url, "GET", req.headers ?? {});
      if (res.status < 200 || res.status >= 300) throw new HttpError(`HTTP ${res.status}`, "network");
      if (req.maxBytes !== undefined && res.body.length > req.maxBytes) throw new HttpError("too large", "too-large");
      const sha = createHash("sha256").update(res.body).digest("hex");
      if (req.sha256 && sha !== req.sha256) throw new HttpError("mismatch", "mismatch");
      if (!fsImpl) throw new Error("fakeHttp download needs a file system");
      await fsImpl.writeBytes(req.dest, res.body);
      req.onProgress?.(res.body.length, res.body.length);
      return { sha256: sha, size: res.body.length };
    },
    async upload(req) {
      if (!fsImpl) throw new Error("fakeHttp upload needs a file system");
      return run(req.url, req.method, req.headers, await fsImpl.readBytes(req.filePath));
    },
  };
}

/** HTTP over Node's real fetch (integration tests against the local dev network). */
export const nodeHttp: Http = {
  async request(req) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs ?? 30_000);
    req.signal?.addEventListener("abort", () => ctl.abort());
    try {
      const res = await fetch(req.url, {
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.body as BodyInit | undefined,
        signal: ctl.signal,
      });
      const body = new Uint8Array(await res.arrayBuffer());
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.status, headers, body, url: res.url };
    } catch (e) {
      throw new HttpError(e instanceof Error ? e.message : String(e), ctl.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  },
  async download() {
    throw new Error("not used");
  },
  async upload() {
    throw new Error("not used");
  },
};
