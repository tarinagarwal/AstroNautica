/**
 * Media worker mode (security review #7): a tiny HTTP server so media parsers run in their own container with no
 * secrets and no internet, reachable only by the publisher over an internal network.
 *
 *   POST /process  { "kind": "image" | "video", "input": "<path>", "outDir": "<path>" }
 *
 * Paths are relative to MEDIA_SHARED_DIR (a volume shared with the publisher) and must stay inside it. Images are
 * written to `outDir` as `original` and `<width>.webp`; the response describes them (no bytes on the wire).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { processImage } from "./image.js";
import { processVideo } from "./video.js";

const SHARED = resolve(process.env.MEDIA_SHARED_DIR ?? "/var/lib/azaadawaaz/media");
const PORT = Number(process.env.MEDIA_PORT ?? 3001);
const HOST = process.env.MEDIA_HOST ?? "0.0.0.0";
const MAX_BODY = 64 * 1024;
let busy = 0;
const MAX_CONCURRENT = Number(process.env.MEDIA_CONCURRENCY ?? 2);

/** Resolve a shared-volume path; refuse anything that escapes it (including through symlinks). */
export function insideShared(p: unknown, shared = SHARED): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024 || p.includes("\0")) throw new Error("bad path");
  const full = resolve(shared, p);
  const rel = relative(shared, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path escapes the shared directory");
  return full;
}

function realInside(full: string, shared = SHARED): string {
  const real = realpathSync(full);
  const rel = relative(realpathSync(shared), real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path escapes the shared directory");
  return real;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function handle(job: { kind: string; input: string; outDir: string }, shared = SHARED) {
  const input = realInside(insideShared(job.input, shared), shared);
  const outDir = insideShared(job.outDir, shared);
  mkdirSync(outDir, { recursive: true });
  realInside(outDir, shared);
  if (job.kind === "image") {
    const r = await processImage(new Uint8Array(readFileSync(input)));
    writeFileSync(join(outDir, "original"), r.original.bytes);
    const variants: Record<string, { file: string; sha256: string; width: number; height: number }> = {};
    for (const [w, v] of Object.entries(r.variants)) {
      if (!v) continue;
      writeFileSync(join(outDir, `${w}.webp`), v.bytes);
      variants[w] = { file: `${w}.webp`, sha256: v.sha256, width: v.width, height: v.height };
    }
    const { bytes: _b, ...original } = r.original;
    return { original: { ...original, file: "original" }, variants, blurhash: r.blurhash };
  }
  if (job.kind === "video") {
    const r = await processVideo(input, outDir);
    const rel = (p: string) => relative(outDir, p);
    return {
      ...r,
      hlsDir: rel(r.hlsDir),
      mp4: { ...r.mp4, path: rel(r.mp4.path) },
      poster: { ...r.poster, path: rel(r.poster.path) },
      preview: { ...r.preview, path: rel(r.preview.path) },
    };
  }
  throw new Error("kind must be image or video");
}

export function startServer() {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, busy });
    if (req.method !== "POST" || req.url !== "/process") return send(res, 404, { error: "not_found" });
    if (busy >= MAX_CONCURRENT) return send(res, 503, { error: "busy" });
    busy++;
    try {
      const job = await readBody(req);
      send(res, 200, await handle(job));
    } catch (e) {
      send(res, 422, { error: "processing_failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy--;
    }
  });
  server.requestTimeout = 0; // long videos
  server.listen(PORT, HOST, () => process.stdout.write(JSON.stringify({ msg: "media worker listening", port: PORT }) + "\n"));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
