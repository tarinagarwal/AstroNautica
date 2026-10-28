import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSecretKey } from "@azaadawaaz/core";

export interface ChainConfig {
  key: string;
  chainId: number;
  rpc: string;
  registry: `0x${string}`;
}

export interface PinningService {
  name: string;
  /** IPFS Pinning Service API base URL, e.g. https://api.filebase.io/v1/ipfs */
  endpoint: string;
  token: string;
}

export interface PublisherConfig {
  databaseUrl: string;
  stagingDir: string;
  workDir: string;
  seedDir: string;
  /** Where the seed box watches for new .torrent files (default: seedDir). */
  seedWatchDir: string;
  ownerPubkey: string;
  bootstrapRelays: string[];
  bootstrapListEvents?: string;
  publisherSecretKey: Uint8Array;
  publisherX25519Private: string;
  publisherEvmKey: `0x${string}`;
  ipfsApis: string[];
  /** Public gateway base URLs used as torrent web seeds. */
  ipfsGateways: string[];
  pinningServices: PinningService[];
  arweaveUrl: string;
  arweaveJwkPath?: string;
  /** Upload full videos to Arweave only up to this many bytes per video (0 = never). */
  arweaveMaxVideoBytes: number;
  /** ArLocal only: mint test tokens and mine blocks after uploads. */
  arweaveDevMine: boolean;
  chains: ChainConfig[];
  /** Relays that must accept the story event before it counts as published (spec §5.1: 3). */
  requiredRelaySuccesses: number;
  pollMs: number;
  workerId: string;
}

/** Load configuration from the environment, falling back to `.dev/config.json` and `.dev/keys.json` in development. */
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env, root = findRepoRoot()): PublisherConfig {
  const env = withFileSecrets(rawEnv);
  const devConfig = readJson(resolve(root, ".dev/config.json"));
  const devKeys = readJson(resolve(root, ".dev/keys.json"));
  const list = (v: string | undefined, fallback: string[] = []) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : fallback;
  const need = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v) throw new Error(`missing configuration: ${name}`);
    return v;
  };

  const nsec = env.PUBLISHER_NSEC ?? devKeys?.publisher?.nsec;
  return {
    databaseUrl: need(env.DATABASE_URL ?? devConfig?.databaseUrl, "DATABASE_URL"),
    stagingDir: resolve(root, need(env.STAGING_DIR ?? devConfig?.stagingDir, "STAGING_DIR")),
    workDir: resolve(root, env.WORK_DIR ?? devConfig?.workDir ?? ".dev/publisher-work"),
    seedDir: resolve(root, env.SEED_DIR ?? devConfig?.seedDir ?? ".dev/seed"),
    seedWatchDir: resolve(root, env.SEEDBOX_WATCH_DIR ?? env.SEED_DIR ?? devConfig?.seedDir ?? ".dev/seed"),
    ownerPubkey: need(env.OWNER_PUBKEY ?? devConfig?.ownerPubkey, "OWNER_PUBKEY"),
    bootstrapRelays: list(env.RELAYS, devConfig?.relays ?? []),
    bootstrapListEvents:
      env.BOOTSTRAP_LIST_EVENTS ??
      (existsSync(resolve(root, ".dev/list-events.json")) ? resolve(root, ".dev/list-events.json") : undefined),
    publisherSecretKey: parseSecretKey(need(nsec, "PUBLISHER_NSEC")),
    publisherX25519Private: need(
      env.PUBLISHER_X25519_PRIVATE ?? devKeys?.publisher?.x25519Private,
      "PUBLISHER_X25519_PRIVATE",
    ),
    publisherEvmKey: need(
      env.PUBLISHER_EVM_KEY ?? devKeys?.publisher?.evmPrivateKey,
      "PUBLISHER_EVM_KEY",
    ) as `0x${string}`,
    ipfsApis: list(env.IPFS_APIS, devConfig?.ipfsApis ?? []),
    ipfsGateways: list(env.IPFS_GATEWAYS, devConfig?.ipfsGateways ?? []),
    pinningServices: env.PINNING_SERVICES ? JSON.parse(env.PINNING_SERVICES) : (devConfig?.pinningServices ?? []),
    arweaveUrl: need(env.ARWEAVE_URL ?? devConfig?.arweave, "ARWEAVE_URL"),
    arweaveJwkPath: env.ARWEAVE_JWK ?? (devConfig ? resolve(root, ".dev/arweave-wallet.json") : undefined),
    arweaveMaxVideoBytes: Number(env.ARWEAVE_MAX_VIDEO_BYTES ?? devConfig?.arweaveMaxVideoBytes ?? 0),
    arweaveDevMine: (env.ARWEAVE_DEV_MINE ?? String(Boolean(devConfig))) === "true",
    chains: env.CHAINS ? JSON.parse(env.CHAINS) : (devConfig?.chains ?? []),
    requiredRelaySuccesses: Number(env.REQUIRED_RELAY_SUCCESSES ?? devConfig?.requiredRelaySuccesses ?? 3),
    pollMs: Number(env.POLL_MS ?? 2000),
    workerId: env.WORKER_ID ?? `publisher-${process.pid}`,
  };
}

/** Variables that may instead be given as Docker secrets via `<NAME>_FILE`. */
export const SECRET_VARS = [
  "DATABASE_URL",
  "DATABASE_PASSWORD",
  "PUBLISHER_NSEC",
  "PUBLISHER_X25519_PRIVATE",
  "PUBLISHER_EVM_KEY",
  "PINNING_SERVICES",
] as const;

/**
 * Docker secrets: for each name in `SECRET_VARS`, `<NAME>_FILE` names a file holding its value (trailing newline
 * trimmed). `<NAME>` itself wins if both are set.
 */
export function withFileSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of SECRET_VARS) {
    const v = env[`${name}_FILE`];
    if (!v) continue;
    if (out[name] === undefined) out[name] = readFileSync(v, "utf8").replace(/\r?\n$/, "");
  }
  if (out.DATABASE_URL === undefined && out.DATABASE_HOST) {
    const u = encodeURIComponent(out.DATABASE_USER ?? "azaad");
    const pw = encodeURIComponent(out.DATABASE_PASSWORD ?? "");
    out.DATABASE_URL = `postgres://${u}:${pw}@${out.DATABASE_HOST}:${out.DATABASE_PORT ?? 5432}/${out.DATABASE_NAME ?? "azaadawaaz"}`;
  }
  return out;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) return resolve(start);
    dir = up;
  }
}
