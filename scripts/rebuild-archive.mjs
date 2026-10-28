#!/usr/bin/env node
/**
 * Rebuild the full public archive (every story, every version, every file) from public networks alone, with no
 * database (spec §11 "Rebuild test", runbook docs/runbooks/restore.md).
 *
 *   node scripts/rebuild-archive.mjs --owner <npub|hex> --relays <urls> --gateways <ipfs gateway urls>
 *        [--arweave <url>] [--chains <json file|json>] [--pin-to <kubo api url>] [--republish-to <relay urls>]
 *        [--out <dir>] [--social] [--json]
 *
 * Sources: story events and storage receipts from relays; every version (including superseded ones, which relays
 * no longer hold) from the chain registries' `Published` logs; manifests and files from IPFS gateways as CAR files
 * (every block's hash is verified and the DAG is checked to be complete) or from Arweave by the storage receipt.
 * Every manifest is fully verified (hash, schema, approval signature, moderator at the time, publisher key).
 * Exits non-zero if anything could not be rebuilt.
 */
import { readFileSync } from "node:fs";
import { toPubkeyHex } from "@azaadawaaz/core";
import { devConfig, list, parseArgs } from "./lib/common.mjs";
import { rebuildArchive } from "./lib/archive.mjs";

const args = parseArgs();
const cfg = devConfig();
const owner = toPubkeyHex(args.owner ?? cfg?.ownerPubkey ?? "");
const relays = list(args.relays, cfg?.relays ?? []);
if (!/^[0-9a-f]{64}$/.test(owner) || relays.length === 0) {
  console.error("--owner and --relays are required");
  process.exit(2);
}
const quiet = Boolean(args.json);
const report = await rebuildArchive({
  owner,
  relays,
  gateways: list(args.gateways, cfg?.ipfsGateways ?? []),
  arweaveUrl: args.arweave ?? cfg?.arweave,
  chains: args.chains
    ? JSON.parse(String(args.chains).trim().startsWith("[") ? args.chains : readFileSync(args.chains, "utf8"))
    : (cfg?.chains ?? []),
  pinTo: args["pin-to"],
  republishTo: list(args["republish-to"]),
  outDir: args.out,
  includeSocial: Boolean(args.social),
  say: quiet ? undefined : (...a) => console.log(...a),
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
const { lists: _lists, ...summary } = report;
if (quiet) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\nRebuilt ${summary.stories} stories, ${summary.versions} versions, ${summary.files} files.`);
  console.log(
    summary.problems.length
      ? `${summary.problems.length} problem(s):\n - ${summary.problems.join("\n - ")}`
      : "No problems.",
  );
}
process.exit(summary.problems.length ? 1 : 0);
