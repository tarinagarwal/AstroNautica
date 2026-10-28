#!/usr/bin/env node
// Smoke test of the write policy against running relays.
//
//   node infra/relay/scripts/pow-smoke.mjs [ws://127.0.0.1:7777 ws://127.0.0.1:7778 ...]
//
// Expects the relays to run with the default policy settings and OWNER_PUBKEY set
// (POW_DIFFICULTY=16, 10 comments/minute). Uses a fresh key per relay, so it
// can be re-run, but wait a minute between runs against the same relay if you
// changed it to use a fixed key.
//
// nostr-tools is resolved from the workspace (packages/core) so this script has
// no install step of its own.

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
    // require.resolve picks the CommonJS build; its exports arrive as `default`.
    const mod = await import(pathToFileURL(require.resolve("nostr-tools")).href);
    return mod.finalizeEvent ? mod : mod.default;
  }
}

const { finalizeEvent, generateSecretKey, getPublicKey, nip13, nip19 } = await loadNostrTools();

// The publisher's sample key from scripts/dev-setup.mjs, for the long-form size
// check (kind 30023 is accepted only from publisher keys or the owner).
function devPublisherKey() {
  try {
    const keys = JSON.parse(readFileSync(join(repoRoot, ".dev", "keys.json"), "utf8"));
    return nip19.decode(keys.publisher.nsec).data;
  } catch {
    return null;
  }
}
const publisherSk = devPublisherKey();

const DIFFICULTY = Number(process.env.POW_DIFFICULTY ?? 16);
const COMMENT_LIMIT = Number(process.env.RATE_COMMENTS_PER_MINUTE ?? 10);
const relays = process.argv.slice(2).length ? process.argv.slice(2) : ["ws://127.0.0.1:7777", "ws://127.0.0.1:7778"];

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
        publish(event) {
          return new Promise((res) => {
            pending.set(event.id, res);
            ws.send(JSON.stringify(["EVENT", event]));
          });
        },
        query(filter) {
          return new Promise((res) => {
            const id = Math.random().toString(36).slice(2);
            subs.set(id, { events: [], done: res });
            ws.send(JSON.stringify(["REQ", id, filter]));
          });
        },
        close() {
          ws.close();
        },
      });
  });
}

const STORY_ID = "f".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

function comment(sk, content, withPow) {
  const unsigned = {
    kind: 1111,
    created_at: now(),
    pubkey: getPublicKey(sk),
    content,
    tags: [
      ["E", STORY_ID],
      ["K", "30023"],
      ["e", STORY_ID],
      ["k", "30023"],
    ],
  };
  return finalizeEvent(withPow ? nip13.minePow(unsigned, DIFFICULTY) : unsigned, sk);
}

function reaction(sk, withPow) {
  const unsigned = {
    kind: 7,
    created_at: now(),
    pubkey: getPublicKey(sk),
    content: "🙏",
    tags: [
      ["e", STORY_ID],
      ["k", "30023"],
    ],
  };
  return finalizeEvent(withPow ? nip13.minePow(unsigned, DIFFICULTY) : unsigned, sk);
}

let failures = 0;
function expect(label, result, ok, pattern) {
  const pass = result.ok === ok && (!pattern || pattern.test(result.msg ?? ""));
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}: ok=${result.ok} msg=${JSON.stringify(result.msg ?? "")}`);
}

for (const url of relays) {
  console.log(`relay ${url} (difficulty ${DIFFICULTY}, ${COMMENT_LIMIT} comments/min)`);
  const relay = await connect(url);
  const sk = generateSecretKey();

  expect("comment without PoW is rejected", await relay.publish(comment(sk, "no work", false)), false, /^pow:/);

  // Hand-made low-commitment nonce tag: real work would not help.
  const cheat = finalizeEvent(
    {
      kind: 1111,
      created_at: now(),
      content: "cheat",
      tags: [
        ["e", STORY_ID],
        ["nonce", "1", "1"],
      ],
    },
    sk,
  );
  expect("comment with nonce committing below difficulty is rejected", await relay.publish(cheat), false, /^pow:/);

  const good = comment(sk, "नमस्ते, this one did the work", true);
  expect(`comment with PoW (${nip13.getPow(good.id)} bits) is accepted`, await relay.publish(good), true);

  expect("reaction without PoW is rejected", await relay.publish(reaction(sk, false)), false, /^pow:/);
  const r = reaction(sk, true);
  expect(`reaction with PoW (${nip13.getPow(r.id)} bits) is accepted`, await relay.publish(r), true);

  expect(
    "comment over 2000 characters is rejected",
    await relay.publish(comment(sk, "x".repeat(2001), true)),
    false,
    /^invalid: comment longer than 2000/,
  );

  const note = finalizeEvent({ kind: 1, created_at: now(), content: "plain note, no work", tags: [] }, sk);
  expect("kind 1 is rejected (kind allowlist)", await relay.publish(note), false, /^blocked:/);

  const story = (key) =>
    finalizeEvent(
      {
        kind: 30023,
        created_at: now(),
        content: "# Story\n\n" + "लेख ".repeat(25_000),
        tags: [["d", "smoke-" + now()]],
      },
      key,
    );
  expect("kind 30023 from a random key is rejected", await relay.publish(story(sk)), false, /^blocked:/);
  if (publisherSk) {
    const longForm = story(publisherSk);
    const size = Buffer.byteLength(JSON.stringify(longForm));
    expect(
      `kind 30023 of ${Math.round(size / 1024)} KiB from the publisher is accepted`,
      await relay.publish(longForm),
      true,
    );
  } else {
    console.log("  SKIP  long-form size check (no .dev/keys.json publisher key)");
  }

  // One comment is already counted; fill the rest of the minute's allowance.
  for (let i = 1; i < COMMENT_LIMIT; i++) {
    const res = await relay.publish(comment(sk, `comment ${i}`, true));
    if (!res.ok) expect(`comment ${i + 1}/${COMMENT_LIMIT} within limit`, res, true);
  }
  console.log(`  ....  sent comments 2..${COMMENT_LIMIT} with PoW`);
  expect(
    `comment ${COMMENT_LIMIT + 1} in the same minute is rate-limited`,
    await relay.publish(comment(sk, "one too many", true)),
    false,
    /^rate-limited:/,
  );
  const other = generateSecretKey();
  expect("another key is not affected", await relay.publish(comment(other, "different key", true)), true);

  const stored = await relay.query({ authors: [getPublicKey(sk)], kinds: [1111], limit: 100 });
  const storedOk = stored.length === COMMENT_LIMIT;
  if (!storedOk) failures++;
  console.log(
    `  ${storedOk ? "PASS" : "FAIL"}  relay stored exactly ${stored.length} comments from the key (expected ${COMMENT_LIMIT})`,
  );
  relay.close();
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all relay policy checks passed");
