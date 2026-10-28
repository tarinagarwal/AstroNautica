#!/usr/bin/env node
/**
 * Mirror kit sync job (spec §10, infra/mirror/README.md). Every SYNC_INTERVAL_SECONDS:
 *  1. fetch and verify the signed lists (last good copy kept in STATE_DIR);
 *  2. export the newest signed web release from IPFS into WEB_ROOT and switch `current` atomically;
 *  3. pin every story version's manifest and files on the local Kubo node (verified CARs from gateways);
 *  4. copy story, receipt, list, comment and reaction events to the local relay.
 * Never logs client addresses (it serves none).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { toPubkeyHex } from "@azaadawaaz/core";
import { fetchVerifiedCar, importCarInto, pinCid, rebuildArchive } from "@azaadawaaz/scripts/archive";

const env = process.env;
const list = (v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const cfg = {
  owner: toPubkeyHex(env.OWNER_PUBKEY ?? ""),
  relays: list(env.BOOTSTRAP_RELAYS),
  gateways: list(env.BOOTSTRAP_GATEWAYS),
  localRelay: env.LOCAL_RELAY_URL ?? "ws://relay:7777",
  ipfsApi: (env.LOCAL_IPFS_API_URL ?? "http://ipfs:5001").replace(/\/+$/, ""),
  webRoot: env.WEB_ROOT ?? "/srv/web",
  stateDir: env.STATE_DIR ?? "/var/lib/mirror-sync",
  interval: Number(env.SYNC_INTERVAL_SECONDS ?? 600),
  chains: env.CHAINS ? JSON.parse(env.CHAINS) : [],
  arweave: env.ARWEAVE_URL,
  once: process.argv.includes("--once"),
};

const log = (msg, extra = {}) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }) + "\n");

if (!/^[0-9a-f]{64}$/.test(cfg.owner) || cfg.relays.length === 0) {
  log("fatal", { error: "OWNER_PUBKEY and BOOTSTRAP_RELAYS are required" });
  process.exit(2);
}
mkdirSync(cfg.stateDir, { recursive: true });
const statePath = join(cfg.stateDir, "lists.json");

async function kubo(path, init = {}) {
  const res = await fetch(`${cfg.ipfsApi}/api/v0/${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(600_000),
    ...init,
  });
  if (!res.ok) throw new Error(`kubo ${path.split("?")[0]}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

/**
 * Export a UnixFS directory from the local node to disk. Kubo verifies every block against its CID while reading, so
 * the files on disk are exactly the signed release.
 */
async function exportDir(cid, dest) {
  const res = await kubo(`ls?arg=${cid}&resolve-type=true&size=false`);
  const { Objects } = await res.json();
  mkdirSync(dest, { recursive: true });
  for (const link of Objects[0].Links) {
    if (link.Name.includes("/") || link.Name === ".." || link.Name === ".")
      throw new Error(`unsafe name in release: ${link.Name}`);
    const p = join(dest, link.Name);
    if (link.Type === 1) await exportDir(link.Hash, p);
    else writeFileSync(p, new Uint8Array(await (await kubo(`cat?arg=${link.Hash}`)).arrayBuffer()));
  }
}

async function syncWeb(lists) {
  const web = lists.releases.filter((r) => r.platform === "web").sort((a, b) => b.versionCode - a.versionCode)[0];
  if (!web) return { web: "no web release in the signed list" };
  const target = join(cfg.webRoot, web.cid);
  const current = join(cfg.webRoot, "current");
  if (!existsSync(target)) {
    // Get the release as a verified CAR from the gateways (every block hash-checked, DAG complete), import it into
    // the local node and pin it. This does not depend on the local node finding peers.
    const { blocks } = await fetchVerifiedCar(web.cid, cfg.gateways);
    await importCarInto(blocks, cfg.ipfsApi);
    await pinCid(web.cid, cfg.ipfsApi);
    const tmp = `${target}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    await exportDir(web.cid, tmp);
    if (!existsSync(join(tmp, "index.html"))) throw new Error("web release has no index.html");
    renameSync(tmp, target);
  }
  // Atomic switch: create a new symlink beside `current` and rename over it.
  const link = join(cfg.webRoot, `.current-${Date.now()}`);
  symlinkSync(web.cid, link);
  renameSync(link, current);
  for (const name of readdirSync(cfg.webRoot)) {
    if (name !== web.cid && name !== "current" && /^b[a-z2-7]{20,}(\.tmp)?$/.test(name))
      rmSync(join(cfg.webRoot, name), { recursive: true, force: true });
  }
  return { web: web.cid, version: web.version };
}

async function syncOnce() {
  let previous = [];
  try {
    previous = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    // first run
  }
  const report = await rebuildArchive({
    owner: cfg.owner,
    relays: cfg.relays,
    gateways: cfg.gateways,
    arweaveUrl: cfg.arweave,
    chains: cfg.chains,
    pinTo: cfg.ipfsApi,
    republishTo: [cfg.localRelay],
    includeSocial: true,
    extraListEvents: previous,
  });
  const { lists, ...summary } = report;
  if (lists.sourceEvents.length) writeFileSync(statePath, JSON.stringify(lists.sourceEvents));
  let web;
  try {
    web = await syncWeb(lists);
  } catch (e) {
    web = { webError: e.message };
  }
  log("sync done", {
    stories: summary.stories,
    versions: summary.versions,
    files: summary.files,
    problems: summary.problems.length,
    moderators: lists.moderators.length,
    relays: lists.relays.length,
    ...web,
  });
  for (const p of summary.problems.slice(0, 20)) log("problem", { detail: p });
  return summary.problems.length === 0;
}

for (;;) {
  let ok = false;
  try {
    ok = await syncOnce();
  } catch (e) {
    log("sync failed", { error: e.message });
  }
  if (cfg.once) process.exit(ok ? 0 : 1);
  await new Promise((r) => setTimeout(r, cfg.interval * 1000));
}
