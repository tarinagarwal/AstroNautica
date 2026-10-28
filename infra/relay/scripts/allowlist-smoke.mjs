#!/usr/bin/env node
// Smoke test of the relay's kind/author allowlist against running relays that
// were started with OWNER_PUBKEY = the dev owner key (.dev/config.json).
//
//   node infra/relay/scripts/allowlist-smoke.mjs [--publisher-story] [ws://127.0.0.1:7777 ...]
//
// Uses the sample keys from scripts/dev-setup.mjs (.dev/keys.json). The owner
// list it publishes re-signs the current moderators list with identical items.
// `--publisher-story` also publishes a throwaway story event signed by the
// publisher key; only use it against a scratch relay (it would show up as a
// broken story on the dev relays, and relays never delete).

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

async function loadNostrTools() {
  try {
    return await import("nostr-tools");
  } catch {
    const require = createRequire(join(repoRoot, "packages", "core", "package.json"));
    const mod = await import(pathToFileURL(require.resolve("nostr-tools")).href);
    return mod.finalizeEvent ? mod : mod.default;
  }
}

const { finalizeEvent, generateSecretKey, getPublicKey, nip13, nip19 } = await loadNostrTools();

const args = process.argv.slice(2);
const withStory = args.includes("--publisher-story");
const relays = args.filter((a) => !a.startsWith("--"));
if (!relays.length) relays.push("ws://127.0.0.1:7777", "ws://127.0.0.1:7778");
const DIFFICULTY = Number(process.env.POW_DIFFICULTY ?? 16);

const keys = JSON.parse(readFileSync(join(repoRoot, ".dev", "keys.json"), "utf8"));
const sk = (k) => nip19.decode(k.nsec).data;
const OWNER = sk(keys.owner);
const PUBLISHER = sk(keys.publisher);
const MODERATOR = sk(keys.moderators[0]);
const now = () => Math.floor(Date.now() / 1000);

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const subs = new Map();
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data[0] === "OK") {
        pending.get(data[1])?.({ ok: data[2], msg: data[3] });
        pending.delete(data[1]);
      } else if (data[0] === "EVENT") {
        subs.get(data[1])?.events.push(data[2]);
      } else if (data[0] === "EOSE") {
        subs.get(data[1])?.done(subs.get(data[1]).events);
        subs.delete(data[1]);
      }
    };
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    ws.onopen = () =>
      resolve({
        publish: (event) =>
          new Promise((res) => {
            pending.set(event.id, res);
            ws.send(JSON.stringify(["EVENT", event]));
          }),
        query: (filter) =>
          new Promise((res) => {
            const id = Math.random().toString(36).slice(2);
            subs.set(id, { events: [], done: res });
            ws.send(JSON.stringify(["REQ", id, filter]));
          }),
        close: () => ws.close(),
      });
  });
}

const list = (name, items, key, createdAt = now()) =>
  finalizeEvent(
    {
      kind: 30078,
      created_at: createdAt,
      tags: [["d", `azaad:list:${name}`]],
      content: JSON.stringify({ schema: "azaadawaaz/list@1", name, items }),
    },
    key,
  );

const comment = (key, withPow) => {
  const target = "f".repeat(64);
  const unsigned = {
    kind: 1111,
    created_at: now(),
    pubkey: getPublicKey(key), // mined ids cover the pubkey
    content: "allowlist smoke",
    tags: [
      ["E", target],
      ["K", "30023"],
      ["e", target],
      ["k", "30023"],
    ],
  };
  return finalizeEvent(withPow ? nip13.minePow(unsigned, DIFFICULTY) : unsigned, key);
};

const story = (key) =>
  finalizeEvent({ kind: 30023, created_at: now(), content: "# smoke", tags: [["d", `allowlist-smoke-${now()}`]] }, key);

let failures = 0;
function expect(label, result, ok) {
  const pass = result.ok === ok;
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}: ok=${result.ok} msg=${JSON.stringify(result.msg ?? "")}`);
}

for (const url of relays) {
  console.log(`relay ${url}`);
  const relay = await connect(url);
  const ownerPub = keys.owner.pubkey;
  const [current] = (
    await relay.query({ kinds: [30078], authors: [ownerPub], "#d": ["azaad:list:moderators"], limit: 1 })
  ).sort((a, b) => b.created_at - a.created_at);
  const items = current ? JSON.parse(current.content).items : [];
  if (!items.some((m) => m.pubkey === keys.moderators[0].pubkey)) {
    failures++;
    console.log("  FAIL  relay has no owner moderators list naming moderator 0 (run scripts/dev-setup.mjs)");
  }
  const createdAt = Math.max(now(), (current?.created_at ?? 0) + 1);
  expect(
    "owner list (re-signed moderators list) accepted",
    await relay.publish(list("moderators", items, OWNER, createdAt)),
    true,
  );
  expect("moderator list from a listed moderator accepted", await relay.publish(list("featured", [], MODERATOR)), true);
  const stranger = generateSecretKey();
  expect("kind 30078 from a random key rejected", await relay.publish(list("hidden", [], stranger)), false);
  expect(
    "kind 30078 moderators list from a random key rejected",
    await relay.publish(list("moderators", [], stranger)),
    false,
  );
  const target = current?.id ?? "0".repeat(64);
  expect(
    "kind 5 deletion (even from the owner) rejected",
    await relay.publish(finalizeEvent({ kind: 5, created_at: now(), content: "", tags: [["e", target]] }, OWNER)),
    false,
  );
  expect(
    "kind 62 request to vanish rejected",
    await relay.publish(
      finalizeEvent({ kind: 62, created_at: now(), content: "", tags: [["relay", "ALL_RELAYS"]] }, stranger),
    ),
    false,
  );
  expect(
    "kind 1 rejected",
    await relay.publish(finalizeEvent({ kind: 1, created_at: now(), content: "note", tags: [] }, stranger)),
    false,
  );
  expect(
    "kind 27235 (NIP-98 auth) rejected",
    await relay.publish(finalizeEvent({ kind: 27235, created_at: now(), content: "", tags: [] }, PUBLISHER)),
    false,
  );
  expect("comment without PoW rejected", await relay.publish(comment(stranger, false)), false);
  expect(`comment with PoW (${DIFFICULTY} bits) accepted`, await relay.publish(comment(stranger, true)), true);
  expect("story from a random key rejected", await relay.publish(story(stranger)), false);
  expect("story from a moderator rejected", await relay.publish(story(MODERATOR)), false);
  expect(
    "audit event from a random key rejected",
    await relay.publish(finalizeEvent({ kind: 9737, created_at: now(), content: "", tags: [] }, stranger)),
    false,
  );
  if (withStory) {
    expect("story from the publisher accepted", await relay.publish(story(PUBLISHER)), true);
  }
  relay.close();
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all relay allowlist checks passed");
