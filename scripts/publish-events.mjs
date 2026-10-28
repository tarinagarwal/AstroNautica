#!/usr/bin/env node
/**
 * Publish signed events (e.g. a list signed offline by the owner) to relays.
 *
 *   node scripts/publish-events.mjs <file.json> [--relays wss://a,wss://b]
 *
 * Without --relays it uses the relays from the official relay list found in the file's events, plus `.dev/config.json`.
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { RelayPool, verifyEventStrict } from "@azaadawaaz/core";
import { devConfig, list, parseArgs } from "./lib/common.mjs";

const args = parseArgs();
const file = args._[0];
if (!file) {
  console.error("usage: publish-events.mjs <file.json> [--relays ...]");
  process.exit(1);
}
const events = [].concat(JSON.parse(readFileSync(file, "utf8")));
for (const e of events) {
  if (!verifyEventStrict(e)) {
    console.error(`event ${e?.id} has an invalid signature; refusing to publish`);
    process.exit(1);
  }
}
const fromLists = events
  .filter((e) => e.tags?.some((t) => t[0] === "d" && t[1] === "azaad:list:relays"))
  .flatMap((e) => JSON.parse(e.content).items.map((i) => i.url));
const relays = [...new Set(list(args.relays, [...fromLists, ...(devConfig()?.relays ?? [])]))];
if (relays.length === 0) {
  console.error("no relays given");
  process.exit(1);
}
const pool = new RelayPool({ websocketImplementation: WebSocket });
let failed = 0;
for (const e of events) {
  const res = await pool.publish(relays, e, 8000);
  const ok = res.filter((r) => r.ok);
  console.log(`${e.id.slice(0, 12)}… kind ${e.kind}: accepted by ${ok.length}/${relays.length}`);
  for (const r of res.filter((r) => !r.ok)) console.log(`  ✗ ${r.relay}: ${r.message}`);
  if (ok.length === 0) failed++;
}
pool.close();
process.exit(failed ? 1 : 0);
