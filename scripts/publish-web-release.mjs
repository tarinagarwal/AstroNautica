#!/usr/bin/env node
/**
 * Put a web app build on IPFS (spec §10 "IPFS door") and print the release entry the owner signs into the `releases`
 * list, from which mirrors pick it up (decision D14).
 *
 *   node scripts/publish-web-release.mjs --version 1.0.0 [--dist apps/web/dist] [--ipfs-apis http://a:5001,http://b:5001]
 *        [--out web-release.json]
 *
 * Then, on the owner machine: node scripts/owner-sign-list.mjs releases --add web-release.json --key … --current …
 * The directory is added with CIDv1 and the same settings on every node, so all nodes agree on the CID.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { devConfig, list, parseArgs, repoRoot } from "./lib/common.mjs";

const args = parseArgs();
const dist = resolve(repoRoot, args.dist ?? "apps/web/dist");
const apis = list(args["ipfs-apis"], devConfig()?.ipfsApis ?? []);
const version = args.version;
if (!version || apis.length === 0) {
  console.error("usage: publish-web-release.mjs --version <x.y.z> [--dist <dir>] [--ipfs-apis <urls>]");
  process.exit(2);
}

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const all = files(dist);
if (!all.some((f) => relative(dist, f) === "index.html")) {
  console.error(`${dist} has no index.html; build the web app first (pnpm --filter @azaadawaaz/web build)`);
  process.exit(1);
}

async function addDir(api) {
  const form = new FormData();
  for (const f of all) form.append("file", new Blob([readFileSync(f)]), `web/${relative(dist, f)}`);
  const url = `${api.replace(/\/+$/, "")}/api/v0/add?cid-version=1&raw-leaves=true&chunker=size-262144&pin=true&wrap-with-directory=false`;
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`${api}: HTTP ${res.status} ${await res.text()}`);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  const root = lines.find((l) => l.Name === "web");
  if (!root) throw new Error(`${api}: no directory CID in response`);
  return root.Hash;
}

const cids = await Promise.all(apis.map((a) => addDir(a).catch((e) => ({ error: e.message }))));
const ok = cids.filter((c) => typeof c === "string");
if (new Set(ok).size > 1) {
  console.error(`nodes disagree on the CID: ${ok.join(", ")}`);
  process.exit(1);
}
if (ok.length === 0) {
  console.error(cids.map((c) => c.error).join("\n"));
  process.exit(1);
}
const [major, minor, patch] = version.split(".").map((n) => Number(n) || 0);
const entry = { platform: "web", version, versionCode: major * 10000 + minor * 100 + patch, cid: ok[0] };
writeFileSync(args.out ?? "web-release.json", JSON.stringify(entry, null, 2));
console.log(`Web ${version} on ${ok.length}/${apis.length} IPFS nodes: ${ok[0]} (${all.length} files)`);
console.log(`Release entry → ${args.out ?? "web-release.json"}`);
