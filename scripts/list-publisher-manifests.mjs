#!/usr/bin/env node
/**
 * List the manifests a publisher key signed, to review before vouching for them after the key is retired
 * (docs/runbooks/key-rotation.md, decision D17).
 *
 *   node scripts/list-publisher-manifests.mjs --publisher <npub|hex> [--before <unix seconds>] [--relays ...] [--chains <json>]
 *        --out manifests.json
 *
 * Sources: story events by that key on relays, and chain receipts written by its EVM address (if --evm is given).
 * Prints a table for review; writes only the manifest sha256s to --out.
 */
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { createPublicClient, http, parseAbiItem } from "viem";
import { KIND_STORY, RelayPool, parseStoryEvent, toPubkeyHex } from "@azaadawaaz/core";
import { bytes16ToStoryId } from "@azaadawaaz/schema";
import { devConfig, list, parseArgs } from "./lib/common.mjs";

const args = parseArgs();
const cfg = devConfig();
if (!args.publisher) {
  console.error("--publisher is required");
  process.exit(2);
}
const pub = toPubkeyHex(args.publisher);
const before = args.before ? Number(args.before) : Infinity;
const relays = list(args.relays, cfg?.relays ?? []);
const rows = new Map();
const pool = new RelayPool({ websocketImplementation: WebSocket });
for (const e of await pool.query(relays, { kinds: [KIND_STORY], authors: [pub] }, 10000)) {
  const r = parseStoryEvent(e);
  if (!r || r.createdAt >= before) continue;
  rows.set(r.manifestSha256, {
    story: r.storyId,
    version: r.version,
    title: r.title,
    source: "relay",
    createdAt: r.createdAt,
  });
}
pool.close();
if (args.evm) {
  const chains = args.chains
    ? JSON.parse(String(args.chains).trim().startsWith("[") ? args.chains : readFileSync(args.chains, "utf8"))
    : (cfg?.chains ?? []);
  const ev = parseAbiItem(
    "event Published(bytes16 indexed storyId, uint32 indexed version, address indexed publisher, bytes32 manifestSha256, string manifestCid, uint64 timestamp)",
  );
  for (const c of chains) {
    const client = createPublicClient({ transport: http(c.rpc) });
    const logs = await client.getLogs({ address: c.registry, event: ev, args: { publisher: args.evm }, fromBlock: 0n });
    for (const l of logs) {
      if (Number(l.args.timestamp) >= before) continue;
      const sha = l.args.manifestSha256.slice(2);
      if (!rows.has(sha))
        rows.set(sha, {
          story: bytes16ToStoryId(l.args.storyId),
          version: Number(l.args.version),
          title: "",
          source: c.key,
          createdAt: Number(l.args.timestamp),
        });
    }
  }
}
for (const [sha, r] of rows)
  console.log(
    `${new Date(r.createdAt * 1000).toISOString()}  ${r.story} v${r.version}  ${sha.slice(0, 16)}…  ${r.source}  ${r.title}`,
  );
writeFileSync(args.out ?? "manifests.json", JSON.stringify([...rows.keys()], null, 2));
console.log(`\n${rows.size} manifests → ${args.out ?? "manifests.json"}. Review every line before vouching.`);
