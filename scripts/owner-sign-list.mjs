#!/usr/bin/env node
/**
 * Sign a new version of an owner list. Designed for the offline owner machine: it reads the current signed list
 * events from a file (made online with `fetch-lists.mjs`), applies one change, signs with the encrypted owner key and
 * writes the new signed event to a file you carry back and publish with `publish-events.mjs`.
 *
 *   node scripts/owner-sign-list.mjs <list> <change> --key owner.key.enc --current lists.json --out signed.json
 *
 * Changes:
 *   mirrors      --add <url> | --remove <url>
 *   onions       --add <address.onion> | --remove <address.onion>
 *   relays       --add <wss url> --operator own|public [--country XX] | --remove <url>
 *   gateways     --add <url> --network ipfs|arweave --operator own|pinning|public | --remove <url>
 *   moderators   --add <npub> --x25519 <hex> [--name <name>] | --remove <npub>
 *   service-keys --rotate-publisher <publisher-keys.json> | --owner-x25519 <hex>
 *   releases     --add <release.json>
 *   overrides    --add <list> <value> | --remove <list> <value>
 *
 * With --nsec-env NAME the secret key is read from that environment variable instead (tests and dev only).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildEffectiveLists, createListEvent, npubToHex, parseSecretKey, keyPairFromSecret } from "@azaadawaaz/core";
import { loadOwnerSecret, parseArgs } from "./lib/common.mjs";

const args = parseArgs();
const [name, ...rest] = args._;
const now = Math.floor(Date.now() / 1000);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!name) fail("usage: owner-sign-list.mjs <list> <change> --key <file> --current <file> --out <file>");
const secret = args["nsec-env"]
  ? parseSecretKey(process.env[args["nsec-env"]] ?? fail(`env ${args["nsec-env"]} is empty`))
  : await loadOwnerSecret(args.key ?? fail("--key is required")).catch((e) => fail(e.message));
const owner = keyPairFromSecret(secret);
const current = args.current ? JSON.parse(readFileSync(args.current, "utf8")) : [];
const lists = buildEffectiveLists(owner.pubkey, current, { now });

const keyOf = {
  mirrors: "mirrors",
  onions: "onions",
  relays: "relays",
  gateways: "gateways",
  moderators: "moderators",
  "service-keys": "serviceKeys",
  releases: "releases",
  overrides: "overrides",
}[name];
if (!keyOf) fail(`unknown owner list: ${name}`);
let items = structuredClone(lists[keyOf]);

const one = (v) => (Array.isArray(v) ? v[0] : v);
switch (name) {
  case "mirrors":
    if (args.add) items = [...items.filter((i) => i.url !== args.add), { url: args.add }];
    else if (args.remove) items = items.filter((i) => i.url !== args.remove);
    else fail("--add or --remove required");
    break;
  case "onions":
    if (args.add) items = [...items.filter((i) => i.address !== args.add), { address: args.add }];
    else if (args.remove) items = items.filter((i) => i.address !== args.remove);
    else fail("--add or --remove required");
    break;
  case "relays":
    if (args.add) {
      const e = { url: args.add, operator: args.operator ?? fail("--operator required") };
      if (args.country) e.country = args.country;
      items = [...items.filter((i) => i.url !== args.add), e];
    } else if (args.remove) items = items.filter((i) => i.url !== args.remove);
    else fail("--add or --remove required");
    break;
  case "gateways":
    if (args.add) {
      const e = {
        url: args.add,
        network: args.network ?? fail("--network required"),
        operator: args.operator ?? fail("--operator required"),
      };
      items = [...items.filter((i) => i.url !== args.add), e];
    } else if (args.remove) items = items.filter((i) => i.url !== args.remove);
    else fail("--add or --remove required");
    break;
  case "moderators":
    if (args.add) {
      const pubkey = npubToHex(args.add);
      const e = { pubkey, x25519: args.x25519 ?? fail("--x25519 required"), from: now };
      if (args.name) e.name = args.name;
      items = [...items.filter((i) => !(i.pubkey === pubkey && i.until === undefined)), e];
    } else if (args.remove) {
      const pubkey = npubToHex(args.remove);
      let found = false;
      items = items.map((i) => {
        if (i.pubkey === pubkey && i.until === undefined) {
          found = true;
          return { ...i, until: now };
        }
        return i;
      });
      if (!found) fail("no active moderator with that key");
    } else fail("--add or --remove required");
    break;
  case "service-keys":
    if (args["rotate-publisher"]) {
      const k = JSON.parse(readFileSync(args["rotate-publisher"], "utf8"));
      items = items.map((i) => (i.role === "publisher" && i.until === undefined ? { ...i, until: now } : i));
      items.push({ role: "publisher", pubkey: k.nostr.pubkey, x25519: k.x25519.publicKey, evm: k.evm.address, from: now });
    } else if (args["owner-x25519"]) {
      items = items.filter((i) => i.role !== "owner");
      items.push({ role: "owner", pubkey: owner.pubkey, x25519: args["owner-x25519"], from: now });
    } else fail("--rotate-publisher or --owner-x25519 required");
    break;
  case "releases":
    if (args.add) {
      const r = JSON.parse(readFileSync(args.add, "utf8"));
      items = [...items.filter((i) => i.versionCode !== r.versionCode), r].sort((a, b) => b.versionCode - a.versionCode);
    } else fail("--add required");
    break;
  case "overrides": {
    const [list, value] = [one(args.add ?? args.remove), args._[1]];
    if (!list || !value) fail("usage: overrides --add <list> <value>");
    items = items.filter((i) => !(i.list === list && i.value === value));
    if (args.add) items.push({ list, value });
    break;
  }
}

const event = createListEvent(name, items, secret, now);
const check = buildEffectiveLists(owner.pubkey, [...current, event], { now });
if (JSON.stringify(check[keyOf]) !== JSON.stringify(items)) fail("signed list failed validation; some items are malformed");
writeFileSync(args.out ?? `${name}.signed.json`, JSON.stringify([event], null, 2));
console.log(`Signed ${name} (${items.length} entries) → ${args.out ?? `${name}.signed.json`}`);
void rest;
