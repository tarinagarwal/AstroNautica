/**
 * Configuration from environment variables, with `.dev/config.json` (written by `scripts/dev-setup.mjs`) as the
 * development fallback (docs/architecture.md, "Keys and configuration").
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { toPubkeyHex } from "@azaadawaaz/core";

export interface Config {
  port: number;
  host: string;
  /** Base URLs clients use to reach this API (first is canonical). NIP-98 `u` tags are compared against these. */
  publicUrls: string[];
  /** Path prefix shared by every public URL (e.g. "/api" behind the production reverse proxy), or "". */
  basePath: string;
  databaseUrl: string;
  stagingDir: string;
  ownerPubkey: string;
  relays: string[];
  allowedOrigins: string[];
  claimMinutes: number;
  unlistPerHour: number;
  submissionsPerHour: number;
  rejectedRetentionDays: number;
  /** `draft` / `changes_requested` submissions not updated for this many days are expired by the retention job. */
  draftRetentionDays: number;
  maxImageBytes: number;
  maxVideoBytes: number;
  maxBlocks: number;
  /** Total declared media bytes of one submission. */
  maxSubmissionBytes: number;
  /** Total declared media bytes across a contributor's submissions whose staging data still exists. */
  maxContributorStagingBytes: number;
  /** Media items per submission. */
  maxMediaPerSubmission: number;
  maxJsonBytes: number;
  bootstrapListEvents?: string;
  listsRefreshSeconds: number;
  cleanupIntervalMinutes: number;
  autoMigrate: boolean;
  logLevel: string;
}

export class ConfigError extends Error {}

interface DevConfig {
  ownerPubkey?: string;
  relays?: string[];
  apiUrl?: string;
  databaseUrl?: string;
  stagingDir?: string;
}

/** Find `.dev/config.json` in `start` or any parent directory. */
export function findDevConfig(start: string): { path: string; root: string } | undefined {
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, ".dev", "config.json");
    if (existsSync(p)) return { path: p, root: dir };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const SIZE = /^(\d+)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i;

/** Parse a byte size: plain bytes or a binary-suffixed value ("20MB" = 20 MiB, "2GB" = 2 GiB). */
export function parseSize(name: string, raw: string | undefined, def: number): number {
  if (raw === undefined || raw.trim() === "") return def;
  const m = SIZE.exec(raw.trim());
  if (!m) throw new ConfigError(`${name} must be a byte size such as 20971520 or 20MB`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase()[0];
  const mult = unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1;
  const v = n * mult;
  if (!Number.isSafeInteger(v) || v <= 0) throw new ConfigError(`${name} is out of range`);
  return v;
}

function parseIntVar(name: string, raw: string | undefined, def: number, min = 1): number {
  if (raw === undefined || raw.trim() === "") return def;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be a whole number`);
  const v = Number(raw.trim());
  if (!Number.isSafeInteger(v) || v < min) throw new ConfigError(`${name} must be at least ${min}`);
  return v;
}

function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePublicUrls(urls: string[]): { publicUrls: string[]; basePath: string } {
  const parsed = urls.map((u) => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      throw new ConfigError(`PUBLIC_URL entry is not a URL: ${u}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("PUBLIC_URL must be http(s)");
    if (url.search || url.hash || url.username || url.password)
      throw new ConfigError("PUBLIC_URL must not contain a query, fragment or credentials");
    const path = url.pathname.replace(/\/+$/, "");
    return { base: url.origin + path, path };
  });
  const basePath = parsed[0]!.path;
  if (parsed.some((p) => p.path !== basePath)) throw new ConfigError("every PUBLIC_URL entry must use the same path");
  return { publicUrls: parsed.map((p) => p.base), basePath };
}

/** Build a connection URL from DATABASE_HOST/PORT/NAME/USER and DATABASE_PASSWORD(_FILE) (docker secrets). */
function databaseUrlFromParts(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.DATABASE_HOST) return undefined;
  if (!env.DATABASE_NAME || !env.DATABASE_USER)
    throw new ConfigError("DATABASE_HOST needs DATABASE_NAME and DATABASE_USER");
  let password = env.DATABASE_PASSWORD ?? "";
  if (env.DATABASE_PASSWORD_FILE) {
    try {
      password = readFileSync(env.DATABASE_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "");
    } catch {
      throw new ConfigError("cannot read DATABASE_PASSWORD_FILE");
    }
  }
  const auth = encodeURIComponent(env.DATABASE_USER) + (password ? `:${encodeURIComponent(password)}` : "");
  const port = parseIntVar("DATABASE_PORT", env.DATABASE_PORT, 5432);
  return `postgres://${auth}@${env.DATABASE_HOST}:${port}/${encodeURIComponent(env.DATABASE_NAME)}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const found = findDevConfig(cwd);
  let dev: DevConfig = {};
  if (found) {
    try {
      dev = JSON.parse(readFileSync(found.path, "utf8")) as DevConfig;
    } catch {
      throw new ConfigError(`cannot parse ${found.path}`);
    }
  }

  const port = parseIntVar("PORT", env.PORT, 8787);
  const publicUrlRaw = parseList(env.PUBLIC_URL) ?? (dev.apiUrl ? [dev.apiUrl] : [`http://127.0.0.1:${port}`]);
  const { publicUrls, basePath } = parsePublicUrls(publicUrlRaw);

  const databaseUrl = env.DATABASE_URL || databaseUrlFromParts(env) || dev.databaseUrl;
  if (!databaseUrl)
    throw new ConfigError("DATABASE_URL (or DATABASE_HOST/NAME/USER[/PASSWORD_FILE]) is required, or .dev/config.json");
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY.toLowerCase() !== "false")
    throw new ConfigError("TRUST_PROXY is always off: the API must never see client addresses");

  const ownerRaw = env.OWNER_PUBKEY || dev.ownerPubkey;
  if (!ownerRaw) throw new ConfigError("OWNER_PUBKEY is required (or .dev/config.json ownerPubkey)");
  let ownerPubkey: string;
  try {
    ownerPubkey = toPubkeyHex(ownerRaw.trim());
  } catch {
    throw new ConfigError("OWNER_PUBKEY must be an npub or 64-char hex key");
  }
  if (!/^[0-9a-f]{64}$/.test(ownerPubkey)) throw new ConfigError("OWNER_PUBKEY must be an npub or 64-char hex key");

  let stagingDir = env.STAGING_DIR || dev.stagingDir;
  if (!stagingDir) throw new ConfigError("STAGING_DIR is required (or .dev/config.json stagingDir)");
  if (!isAbsolute(stagingDir)) stagingDir = resolve(env.STAGING_DIR ? cwd : (found?.root ?? cwd), stagingDir);

  const relays = parseList(env.RELAYS) ?? dev.relays ?? [];
  for (const r of relays) {
    if (!/^wss?:\/\//.test(r)) throw new ConfigError(`RELAYS entry must be ws:// or wss://: ${r}`);
  }

  return {
    port,
    host: env.HOST || "127.0.0.1",
    publicUrls,
    basePath,
    databaseUrl,
    stagingDir,
    ownerPubkey,
    relays,
    allowedOrigins: parseList(env.ALLOWED_ORIGINS) ?? ["http://localhost:5173", "http://127.0.0.1:5173"],
    claimMinutes: parseIntVar("CLAIM_MINUTES", env.CLAIM_MINUTES, 30),
    unlistPerHour: parseIntVar("UNLIST_PER_HOUR", env.UNLIST_PER_HOUR, 5),
    submissionsPerHour: parseIntVar("SUBMISSIONS_PER_HOUR", env.SUBMISSIONS_PER_HOUR, 30),
    rejectedRetentionDays: parseIntVar("REJECTED_RETENTION_DAYS", env.REJECTED_RETENTION_DAYS, 30, 0),
    draftRetentionDays: parseIntVar("DRAFT_RETENTION_DAYS", env.DRAFT_RETENTION_DAYS, 30, 1),
    maxImageBytes: parseSize("MAX_IMAGE_BYTES", env.MAX_IMAGE_BYTES, 20 * 1024 ** 2),
    maxVideoBytes: parseSize("MAX_VIDEO_BYTES", env.MAX_VIDEO_BYTES, 2 * 1024 ** 3),
    maxBlocks: parseIntVar("MAX_BLOCKS", env.MAX_BLOCKS, 100),
    maxSubmissionBytes: parseSize("MAX_SUBMISSION_BYTES", env.MAX_SUBMISSION_BYTES, 4 * 1024 ** 3),
    maxContributorStagingBytes: parseSize(
      "MAX_CONTRIBUTOR_STAGING_BYTES",
      env.MAX_CONTRIBUTOR_STAGING_BYTES,
      8 * 1024 ** 3,
    ),
    maxMediaPerSubmission: parseIntVar("MAX_MEDIA_PER_SUBMISSION", env.MAX_MEDIA_PER_SUBMISSION, 200),
    maxJsonBytes: parseSize("MAX_JSON_BYTES", env.MAX_JSON_BYTES, 8 * 1024 ** 2),
    bootstrapListEvents: env.BOOTSTRAP_LIST_EVENTS || undefined,
    listsRefreshSeconds: parseIntVar("LISTS_REFRESH_SECONDS", env.LISTS_REFRESH_SECONDS, 30),
    cleanupIntervalMinutes: parseIntVar("CLEANUP_INTERVAL_MINUTES", env.CLEANUP_INTERVAL_MINUTES, 60),
    autoMigrate: (env.AUTO_MIGRATE ?? "true").toLowerCase() !== "false",
    logLevel: env.LOG_LEVEL || "info",
  };
}
