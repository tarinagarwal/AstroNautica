#!/usr/bin/env node
/**
 * Download the current signed lists (owner and moderators) from relays into a file, to carry to the offline owner
 * machine for `owner-sign-list.mjs --current`.
 *
 *   node scripts/fetch-lists.mjs --owner <npub|hex> [--relays wss://a,wss://b] --out lists.json
 */
import { writeFileSync } from "node:fs";
import WebSocket from "ws";
import { buildEffectiveLists, KIND_APP_DATA, RelayPool, toPubkeyHex } from "@azaadawaaz/core";
import { devConfig, list, parseArgs } from "./lib/common.mjs";

const args = parseArgs();
const cfg = devConfig();
const owner = toPubkeyHex(args.owner ?? cfg?.ownerPubkey ?? "");
if (!/^[0-9a-f]{64}$/.test(owner)) {
  console.error("--owner is required");
  process.exit(1);
}
const relays = list(args.relays, cfg?.relays ?? []);
const pool = new RelayPool({ websocketImplementation: WebSocket });
const events = await pool.query(relays, { kinds: [KIND_APP_DATA], authors: [owner] }, 8000);
const first = buildEffectiveLists(owner, events);
const all = [...new Set([...relays, ...first.relays.map((r) => r.url)])];
if (first.activeModerators.size)
  events.push(...(await pool.query(all, { kinds: [KIND_APP_DATA], authors: [...first.activeModerators] }, 8000)));
pool.close();
const lists = buildEffectiveLists(owner, events);
writeFileSync(args.out ?? "lists.json", JSON.stringify(lists.sourceEvents, null, 2));
console.log(
  `Saved ${lists.sourceEvents.length} list events (${lists.moderators.length} moderators, ${lists.relays.length} relays) → ${args.out ?? "lists.json"}`,
);
