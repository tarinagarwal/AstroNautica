#!/usr/bin/env node
// Writes src/defaults.json: the pinned owner key and the owner-signed list events bundled into the build.
//
// Sources (first found wins):
//   - DEFAULTS_CONFIG / DEFAULTS_LIST_EVENTS environment variables (paths), for production builds;
//   - ../../.dev/config.json and ../../.dev/list-events.json, written by scripts/dev-setup.mjs (dev only).
// When neither exists the file is still written with empty values, and the app shows "no official lists found".
//
// Only public data goes in: the owner's public key, signed list events, the API URL, chain receipts config and
// bootstrap relays. Never secret keys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const out = resolve(here, "../src/defaults.json");

const configPath = process.env.DEFAULTS_CONFIG ?? resolve(root, ".dev/config.json");
const listsPath = process.env.DEFAULTS_LIST_EVENTS ?? resolve(root, ".dev/list-events.json");

const readJson = (p) => {
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`gen-defaults: ignoring unreadable ${p}: ${e.message}`);
    return undefined;
  }
};

const config = readJson(configPath) ?? {};
const lists = readJson(listsPath);
const listEvents = Array.isArray(lists) ? lists : Array.isArray(lists?.events) ? lists.events : [];

const isHex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const chains = Array.isArray(config.chains)
  ? config.chains
      .filter((c) => c && typeof c.rpc === "string" && typeof c.registry === "string")
      .map((c) => ({
        key: String(c.key ?? c.chainId),
        chainId: Number(c.chainId),
        rpc: c.rpc,
        registry: c.registry,
        ...(c.name ? { name: String(c.name) } : {}),
        ...(c.explorer ? { explorer: String(c.explorer) } : {}),
      }))
  : [];

const defaults = {
  ownerPubkey: isHex64(config.ownerPubkey) ? config.ownerPubkey : "",
  listEvents: listEvents.filter((e) => e && typeof e === "object" && typeof e.id === "string"),
  apiUrl: typeof config.apiUrl === "string" ? config.apiUrl : "",
  bootstrapRelays: Array.isArray(config.relays) ? config.relays.filter((r) => typeof r === "string") : [],
  chains,
  listSnapshots: Array.isArray(config.listSnapshots) ? config.listSnapshots : [],
  powDifficulty: Number.isInteger(config.powDifficulty) ? config.powDifficulty : 16,
};

let json = JSON.stringify(defaults, null, 2) + "\n";
try {
  // Match the repository's formatting when Prettier is installed (it is a root dev dependency).
  const prettier = await import("prettier");
  json = await prettier.format(json, { parser: "json", printWidth: 120 });
} catch {
  // plain JSON is fine
}
const prev = existsSync(out) ? readFileSync(out, "utf8") : "";
if (prev !== json) writeFileSync(out, json);
console.log(
  `gen-defaults: ${defaults.ownerPubkey ? "owner key set" : "no owner key"}, ${defaults.listEvents.length} list events, ` +
    `${defaults.chains.length} chains -> src/defaults.json`,
);
