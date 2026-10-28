/**
 * The real end-to-end environment: no mocks. It uses the local dev network (`infra/dev` docker compose and
 * `node scripts/dev-setup.mjs`), starts the real API (port 8787) and the real publisher against it, the way
 * `scripts/e2e.mjs` does, and serves the production build of the app (localnet CSP) with `vite preview` on port
 * 4800. It also makes the contributor's media the way a phone would: a JPEG carrying GPS and device EXIF and an
 * MP4 carrying a location atom.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const repo = resolve(web, "../..");
export const OUT = join(web, "test-results/real");
export const APP_PORT = 4800;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const DIST = join(OUT, "dist");
const MEDIA = join(OUT, "media");

interface DevConfig {
  ownerPubkey: string;
  relays: string[];
  apiUrl: string;
  databaseUrl: string;
  stagingDir: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | false | null>, ms: number, label: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

function makeMedia(): void {
  mkdirSync(MEDIA, { recursive: true });
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  const gps = (file: string, lat: string, lon: string) =>
    execFileSync("exiftool", [
      "-q",
      "-overwrite_original",
      `-GPSLatitude=${lat}`,
      "-GPSLatitudeRef=N",
      `-GPSLongitude=${lon}`,
      "-GPSLongitudeRef=E",
      "-Make=Samsung",
      "-Model=SM-G991B",
      "-DateTimeOriginal=2026:10:20 07:15:00",
      "-Artist=Real Name",
      file,
    ]);
  const photo = join(MEDIA, "photo.jpg");
  ff(["-f", "lavfi", "-i", "testsrc=size=1600x900", "-frames:v", "1", "-q:v", "3", photo]);
  gps(photo, "28.6139", "77.2090");
  const cover = join(MEDIA, "cover.jpg");
  ff(["-f", "lavfi", "-i", "smptebars=size=1280x720", "-frames:v", "1", "-q:v", "3", cover]);
  gps(cover, "26.8467", "80.9462");
  ff([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-metadata",
    "location=+28.6139+077.2090/",
    "-metadata",
    "make=Samsung",
    "-metadata",
    "model=SM-G991B",
    "-metadata",
    "creation_time=2026-10-20T07:15:00Z",
    "-movflags",
    "+use_metadata_tags",
    join(MEDIA, "clip.mp4"),
  ]);
  // Sanity: the inputs really carry location metadata before the browser strips it.
  const exif = execFileSync("exiftool", ["-s", "-GPSLatitude", photo]).toString();
  if (!/GPSLatitude/.test(exif)) throw new Error("test JPEG has no GPS");
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_format", join(MEDIA, "clip.mp4")]).toString();
  if (!/28\.6139/.test(probe)) throw new Error("test MP4 has no location");
}

export default async function globalSetup() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const cfgPath = join(repo, ".dev/config.json");
  if (!existsSync(cfgPath) || !existsSync(join(repo, ".dev/keys.json")))
    throw new Error("run `node scripts/dev-setup.mjs` first (with the infra/dev docker compose stack up)");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as DevConfig;
  if (await fetch(`${cfg.apiUrl}/health`).then(
    (r) => r.ok,
    () => false,
  ))
    throw new Error(`something is already listening on ${cfg.apiUrl}; stop it first`);

  makeMedia();

  // Services, as scripts/e2e.mjs starts them.
  const stagingDir = resolve(repo, cfg.stagingDir);
  mkdirSync(stagingDir, { recursive: true });
  const children: ChildProcess[] = [];
  const died: string[] = [];
  let stopping = false;
  const start = (name: string, script: string, env: Record<string, string>) => {
    const log = createWriteStream(join(OUT, `${name}.log`));
    const p = spawn("node", [script], { cwd: repo, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout!.pipe(log);
    p.stderr!.pipe(log);
    p.on("exit", (code) => {
      if (!stopping) died.push(`${name} exited with code ${code}`);
    });
    children.push(p);
  };
  start("api", "services/api/dist/main.js", {
    PORT: "8787",
    PUBLIC_URL: cfg.apiUrl,
    DATABASE_URL: cfg.databaseUrl,
    STAGING_DIR: stagingDir,
    OWNER_PUBKEY: cfg.ownerPubkey,
    RELAYS: cfg.relays.join(","),
    LISTS_REFRESH_SECONDS: "2",
    AUTO_MIGRATE: "true",
    ALLOWED_ORIGINS: APP_ORIGIN,
  });
  const stop = () => {
    stopping = true;
    for (const c of children) c.kill("SIGTERM");
  };
  process.on("exit", stop);
  try {
    await until(async () => died.length === 0 && (await fetch(`${cfg.apiUrl}/health`)).ok, 30_000, "API health");
    await until(
      async () => ((await (await fetch(`${cfg.apiUrl}/config`)).json()) as { moderators?: unknown[] }).moderators?.length,
      30_000,
      "API lists",
    );
    start("publisher", "services/publisher/dist/main.js", { POLL_MS: "500", STAGING_DIR: stagingDir });
    await sleep(1500);
    if (died.length) throw new Error(died.join("; "));

    // The app with the dev network's owner key and signed lists bundled (src/defaults.json from .dev/), built for the
    // local network (CSP allows loopback).
    execFileSync("node", ["scripts/gen-defaults.mjs"], { cwd: web, stdio: "ignore" });
    await build({ root: web, mode: "localnet", logLevel: "warn", build: { outDir: DIST, emptyOutDir: true } });
  } catch (e) {
    stop();
    throw e;
  }
  const server = await preview({
    root: web,
    mode: "localnet",
    build: { outDir: DIST },
    preview: { port: APP_PORT, strictPort: true, host: "127.0.0.1" },
  });
  writeFileSync(join(OUT, "env.json"), JSON.stringify({ apiUrl: cfg.apiUrl, media: MEDIA }));

  return async () => {
    await server.close();
    stop();
    await sleep(500);
    if (died.length) console.warn(died.join("; "));
    rmSync(DIST, { recursive: true, force: true });
  };
}
