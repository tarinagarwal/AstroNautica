import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  countLeadingZeroBits,
  checkPow,
  codePointLength,
  createPolicy,
  handleLine,
  loadConfig,
  KIND_COMMENT,
  KIND_REACTION,
  npubToHex,
  parseOwnerPubkey,
  learnFromEvent,
  emptyState,
  ingestEvents,
  bootstrapLines,
  parseEvents,
  D_MODERATORS,
  D_SERVICE_KEYS,
} from "../policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = join(here, "..", "policy.js");

/** A 64-char hex id with exactly `bits` leading zero bits. */
function idWithBits(bits, salt = 0) {
  const zeroNibbles = Math.floor(bits / 4);
  const rem = bits % 4;
  // first non-zero nibble: rem leading zeros inside it -> 8>>rem (8,4,2,1)
  const nibble = (8 >> rem).toString(16);
  const tail = salt.toString(16).padStart(64, "f");
  return ("0".repeat(zeroNibbles) + nibble + tail).slice(0, 64);
}

const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);
let counter = 0;

function ev({ kind = KIND_COMMENT, bits = 16, target = 16, content = "hello", pubkey = PUB_A, nonce = true } = {}) {
  counter++;
  const tags = [["e", "c".repeat(64)]];
  if (nonce) tags.push(target === null ? ["nonce", "123"] : ["nonce", String(counter), String(target)]);
  return { id: idWithBits(bits, counter), pubkey, kind, content, tags, created_at: 1, sig: "d".repeat(128) };
}

function req(event, sourceType = "IP4") {
  return { type: "new", event, receivedAt: 1, sourceType, sourceInfo: "203.0.113.9" };
}

const defaults = loadConfig({});

describe("countLeadingZeroBits", () => {
  test("matches NIP-13 examples", () => {
    assert.equal(countLeadingZeroBits("000000000e9d97a1ab09fc381030b346cdd7a142ad57e6df0b46dc9bef6c7e2d"), 36);
    assert.equal(countLeadingZeroBits("ff"), 0);
    assert.equal(countLeadingZeroBits("7f"), 1);
    assert.equal(countLeadingZeroBits("3f"), 2);
    assert.equal(countLeadingZeroBits("1f"), 3);
    assert.equal(countLeadingZeroBits("0f"), 4);
    assert.equal(countLeadingZeroBits("0".repeat(64)), 256);
  });
  test("helper builds ids with the requested bits", () => {
    for (const b of [0, 1, 5, 15, 16, 17, 20, 31]) assert.equal(countLeadingZeroBits(idWithBits(b)), b);
  });
});

describe("loadConfig", () => {
  test("defaults follow the spec", () => {
    assert.deepEqual(defaults, {
      powDifficulty: 16,
      commentsPerMinute: 10,
      reactionsPerMinute: 60,
      maxCommentChars: 2000,
      rateLimitTrustedSources: false,
      ownerPubkey: "",
      stateFile: "/app/strfry-db/policy-state.json",
    });
  });
  test("reads overrides", () => {
    const c = loadConfig({
      POW_DIFFICULTY: "20",
      RATE_COMMENTS_PER_MINUTE: "3",
      RATE_REACTIONS_PER_MINUTE: "5",
      MAX_COMMENT_CHARS: "50",
    });
    assert.equal(c.powDifficulty, 20);
    assert.equal(c.commentsPerMinute, 3);
    assert.equal(c.reactionsPerMinute, 5);
    assert.equal(c.maxCommentChars, 50);
  });
  test("rejects garbage", () => {
    assert.throws(() => loadConfig({ POW_DIFFICULTY: "abc" }));
    assert.throws(() => loadConfig({ POW_DIFFICULTY: "-1" }));
    assert.throws(() => loadConfig({ POW_DIFFICULTY: "300" }));
  });
});

describe("checkPow", () => {
  test("accepts enough work with a matching commitment", () => {
    assert.equal(checkPow(ev({ bits: 16, target: 16 }), 16), null);
    assert.equal(checkPow(ev({ bits: 21, target: 18 }), 16), null);
  });
  test("rejects too little work", () => {
    assert.match(checkPow(ev({ bits: 15, target: 16 }), 16), /^pow: difficulty 15 is less than 16/);
  });
  test("rejects a low commitment even when the id happens to be lucky", () => {
    assert.match(checkPow(ev({ bits: 20, target: 8 }), 16), /^pow: committed target 8 is less than 16/);
  });
  test("rejects a missing nonce tag or missing commitment", () => {
    assert.match(checkPow(ev({ bits: 20, nonce: false }), 16), /^pow: missing nonce tag/);
    assert.match(checkPow(ev({ bits: 20, target: null }), 16), /^pow: nonce tag must commit/);
  });
  test("difficulty 0 disables the check", () => {
    assert.equal(checkPow(ev({ bits: 0, nonce: false }), 0), null);
  });
});

describe("createPolicy", () => {
  test("rejects deletions, vanish requests, auth events and unknown kinds (open mode too)", () => {
    const p = createPolicy(defaults);
    assert.equal(p.openMode, true);
    for (const kind of [0, 1, 3, 4, 5, 62, 1984, 10002, 27235, 30000, 31990]) {
      const r = p.decide(req(ev({ kind, bits: 32, target: 32 })));
      assert.equal(r.action, "reject", `kind ${kind}`);
      assert.match(r.msg, /^blocked: /);
    }
    assert.match(p.decide(req(ev({ kind: 5 }))).msg, /deletion/);
    assert.match(p.decide(req(ev({ kind: 27235 }))).msg, /never stored/);
  });

  test("open dev mode (no OWNER_PUBKEY) accepts stories, lists and audit events from anyone", () => {
    const p = createPolicy(defaults);
    for (const kind of [30023, 30078, 9737]) {
      assert.equal(p.decide(req(ev({ kind, bits: 0, nonce: false, content: "x".repeat(5000) }))).action, "accept");
    }
  });

  test("requires PoW on comments and reactions", () => {
    const p = createPolicy(defaults);
    assert.equal(p.decide(req(ev({ kind: KIND_COMMENT, bits: 8, target: 16 }))).action, "reject");
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, bits: 8, target: 16 }))).action, "reject");
    assert.equal(p.decide(req(ev({ kind: KIND_COMMENT, bits: 16, target: 16 }))).action, "accept");
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, bits: 16, target: 16 }))).action, "accept");
  });

  test("comment length is counted in characters, limit inclusive", () => {
    const p = createPolicy(defaults);
    assert.equal(p.decide(req(ev({ content: "x".repeat(2000) }))).action, "accept");
    const long = p.decide(req(ev({ content: "x".repeat(2001) })));
    assert.equal(long.action, "reject");
    assert.match(long.msg, /^invalid: comment longer than 2000/);
    // Devanagari and emoji: 2000 code points but many more UTF-8 bytes / UTF-16 units
    const hindi = "न".repeat(1000) + "🙏".repeat(1000);
    assert.equal(codePointLength(hindi), 2000);
    assert.equal(p.decide(req(ev({ content: hindi, pubkey: PUB_B }))).action, "accept");
  });

  test("length is not enforced on reactions", () => {
    const p = createPolicy(defaults);
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, content: "x".repeat(3000) }))).action, "accept");
  });

  test("rate-limits comments per pubkey per minute", () => {
    let t = 1_000_000;
    const p = createPolicy(defaults, () => t);
    for (let i = 0; i < 10; i++) assert.equal(p.decide(req(ev({ pubkey: PUB_A }))).action, "accept", `comment ${i}`);
    const r = p.decide(req(ev({ pubkey: PUB_A })));
    assert.equal(r.action, "reject");
    assert.match(r.msg, /^rate-limited: at most 10 comments per minute/);
    // another key is unaffected
    assert.equal(p.decide(req(ev({ pubkey: PUB_B }))).action, "accept");
    // reactions from the limited key use their own bucket
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, pubkey: PUB_A }))).action, "accept");
    // sliding window
    t += 59_999;
    assert.equal(p.decide(req(ev({ pubkey: PUB_A }))).action, "reject");
    t += 1;
    assert.equal(p.decide(req(ev({ pubkey: PUB_A }))).action, "accept");
  });

  test("rate-limits reactions at 60/minute", () => {
    let t = 0;
    const p = createPolicy(defaults, () => t);
    for (let i = 0; i < 60; i++) {
      t += 10;
      assert.equal(p.decide(req(ev({ kind: KIND_REACTION }))).action, "accept");
    }
    assert.match(p.decide(req(ev({ kind: KIND_REACTION }))).msg, /^rate-limited: at most 60 reactions/);
  });

  test("rejected events do not use up the allowance", () => {
    const p = createPolicy({ ...defaults, commentsPerMinute: 2 });
    for (let i = 0; i < 5; i++) assert.equal(p.decide(req(ev({ bits: 1 }))).action, "reject");
    assert.equal(p.decide(req(ev())).action, "accept");
    assert.equal(p.decide(req(ev())).action, "accept");
    assert.equal(p.decide(req(ev())).action, "reject");
  });

  test("relay-to-relay sources skip rate limits but not PoW", () => {
    const p = createPolicy({ ...defaults, commentsPerMinute: 1 });
    for (let i = 0; i < 5; i++) assert.equal(p.decide(req(ev(), "Stream")).action, "accept");
    assert.equal(p.decide(req(ev({ bits: 3 }), "Sync")).action, "reject");
    const strict = createPolicy({ ...defaults, commentsPerMinute: 1, rateLimitTrustedSources: true });
    assert.equal(strict.decide(req(ev(), "Stream")).action, "accept");
    assert.equal(strict.decide(req(ev(), "Stream")).action, "reject");
  });

  test("old history is swept", () => {
    let t = 0;
    const p = createPolicy(defaults, () => t);
    for (let i = 0; i < 50; i++) p.decide(req(ev({ pubkey: i.toString(16).padStart(64, "0") })));
    assert.equal(p._history.size, 50);
    t += 120_000;
    p.decide(req(ev({ pubkey: PUB_A })));
    assert.equal(p._history.size, 1);
  });
});

describe("handleLine", () => {
  const p = createPolicy(defaults);
  test("answers with id/action/msg and never echoes the source IP", () => {
    const bad = ev({ bits: 2 });
    const out = handleLine(p, JSON.stringify(req(bad)));
    const parsed = JSON.parse(out);
    assert.equal(parsed.id, bad.id);
    assert.equal(parsed.action, "reject");
    assert.ok(parsed.msg.startsWith("pow:"));
    assert.ok(!out.includes("203.0.113.9"));
    const good = ev();
    assert.deepEqual(JSON.parse(handleLine(p, JSON.stringify(req(good)))), { id: good.id, action: "accept" });
  });
  test('ignores blank lines and non-"new" requests', () => {
    assert.equal(handleLine(p, ""), null);
    assert.equal(handleLine(p, JSON.stringify({ type: "lookback", event: ev() })), null);
  });
});

test("runs as a strfry plugin over stdin/stdout without logging the IP", async () => {
  const child = spawn(process.execPath, [POLICY], {
    env: {
      ...process.env,
      POW_DIFFICULTY: "16",
      RATE_COMMENTS_PER_MINUTE: "1",
      OWNER_PUBKEY: "",
      POLICY_STATE_FILE: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const events = [ev({ bits: 4 }), ev(), ev(), ev({ kind: 1, bits: 0, nonce: false }), ev({ kind: 5 })];
  child.stdin.write("not json\n");
  for (const e of events) child.stdin.write(JSON.stringify(req(e)) + "\n");
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.id, l.action]),
    [
      [events[0].id, "reject"],
      [events[1].id, "accept"],
      [events[2].id, "reject"],
      [events[3].id, "reject"],
      [events[4].id, "reject"],
    ],
  );
  assert.match(lines[2].msg, /^rate-limited/);
  assert.ok(!stdout.includes("203.0.113.9"));
  assert.ok(!stderr.includes("203.0.113.9"));
  assert.match(stderr, /azaad-policy: started \(pow=16, comments\/min=1/);
  assert.match(stderr, /OPEN DEV MODE/);
});

// ---------------------------------------------------------------- allowlist

const OWNER = "1".repeat(64);
const MOD = "2".repeat(64);
const MOD_OLD = "3".repeat(64);
const PUBLISHER = "4".repeat(64);
const PUBLISHER_OLD = "5".repeat(64);
const STRANGER = "6".repeat(64);
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
let idSeq = 0;

function hexId() {
  idSeq++;
  return idSeq.toString(16).padStart(64, "9");
}

function listEvent(d, items, { pubkey = OWNER, createdAt = NOW - 100, name } = {}) {
  const listName = name ?? d.slice("azaad:list:".length);
  return {
    id: hexId(),
    pubkey,
    kind: 30078,
    created_at: createdAt,
    tags: [["d", d]],
    content: JSON.stringify({ schema: "azaadawaaz/list@1", name: listName, items }),
    sig: "d".repeat(128),
  };
}

const modsList = (opts) =>
  listEvent(
    D_MODERATORS,
    [
      { pubkey: MOD, x25519: "a".repeat(64), from: NOW - 1000 },
      { pubkey: MOD_OLD, x25519: "b".repeat(64), from: NOW - 5000, until: NOW - 10 },
    ],
    opts,
  );
const keysList = (opts) =>
  listEvent(
    D_SERVICE_KEYS,
    [
      { role: "owner", pubkey: OWNER, from: 0 },
      { role: "publisher", pubkey: PUBLISHER, from: NOW - 1000 },
      { role: "publisher", pubkey: PUBLISHER_OLD, from: 0, until: NOW - 1000 },
    ],
    opts,
  );

function plain(kind, pubkey, extra = {}) {
  return { id: hexId(), pubkey, kind, created_at: NOW, tags: [], content: "", sig: "d".repeat(128), ...extra };
}

function tmpState() {
  return join(mkdtempSync(join(tmpdir(), "azaad-policy-")), "policy-state.json");
}

function strict(extra = {}) {
  return createPolicy({ ...defaults, ownerPubkey: OWNER, stateFile: null, ...extra }, () => NOW_MS);
}

describe("owner key parsing", () => {
  test("accepts hex (any case) and npub", () => {
    assert.equal(parseOwnerPubkey(""), "");
    assert.equal(parseOwnerPubkey(undefined), "");
    assert.equal(parseOwnerPubkey("AB".repeat(32)), "ab".repeat(32));
    // NIP-19 test vector
    const npub = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
    const hex = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    assert.equal(npubToHex(npub), hex);
    assert.equal(parseOwnerPubkey(npub), hex);
    assert.equal(loadConfig({ OWNER_PUBKEY: npub }).ownerPubkey, hex);
  });
  test("rejects malformed keys and bad checksums", () => {
    assert.throws(() => parseOwnerPubkey("abc"));
    assert.throws(() => parseOwnerPubkey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"));
    assert.throws(() => parseOwnerPubkey("npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjpth"));
    assert.throws(() => loadConfig({ OWNER_PUBKEY: "g".repeat(64) }));
  });
  test("POLICY_STATE_FILE: default path, override, empty disables", () => {
    assert.equal(loadConfig({}).stateFile, "/app/strfry-db/policy-state.json");
    assert.equal(loadConfig({ POLICY_STATE_FILE: "/x/y.json" }).stateFile, "/x/y.json");
    assert.equal(loadConfig({ POLICY_STATE_FILE: "" }).stateFile, null);
  });
});

describe("authorised keys", () => {
  test("before any list is known only the owner may write stories, lists and audit events", () => {
    const p = strict();
    assert.equal(p.openMode, false);
    for (const kind of [30023, 30078, 9737]) {
      assert.equal(p.decide(req(plain(kind, OWNER))).action, "accept", `owner kind ${kind}`);
      const r = p.decide(req(plain(kind, STRANGER)));
      assert.equal(r.action, "reject", `stranger kind ${kind}`);
      assert.match(r.msg, /^blocked: /);
    }
  });

  test("learns moderators and publishers from the owner lists", () => {
    const p = strict();
    assert.equal(p.decide(req(modsList())).action, "accept");
    assert.equal(p.decide(req(keysList())).action, "accept");
    // moderator: lists and audit events, no stories
    assert.equal(p.decide(req(listEvent("azaad:list:hidden", [], { pubkey: MOD }))).action, "accept");
    assert.equal(p.decide(req(plain(9737, MOD))).action, "accept");
    assert.equal(p.decide(req(plain(30023, MOD))).action, "reject");
    // removed moderator (until in the past)
    assert.equal(p.decide(req(listEvent("azaad:list:hidden", [], { pubkey: MOD_OLD }))).action, "reject");
    assert.equal(p.decide(req(plain(9737, MOD_OLD))).action, "reject");
    // publishers, including a retired key (its older events must stay storable)
    for (const pk of [PUBLISHER, PUBLISHER_OLD]) {
      assert.equal(p.decide(req(plain(30023, pk))).action, "accept");
      assert.equal(p.decide(req(plain(30078, pk, { tags: [["d", "azaad:storage:x:1"]] }))).action, "accept");
      assert.equal(p.decide(req(plain(9737, pk))).action, "reject");
    }
    // strangers stay out
    assert.equal(p.decide(req(plain(30023, STRANGER))).action, "reject");
    assert.equal(p.decide(req(plain(30078, STRANGER))).action, "reject");
  });

  test("a moderator whose `until` passes stops counting", () => {
    let t = NOW_MS;
    const p = createPolicy({ ...defaults, ownerPubkey: OWNER, stateFile: null }, () => t);
    p.decide(req(listEvent(D_MODERATORS, [{ pubkey: MOD, x25519: "a".repeat(64), from: 0, until: NOW + 60 }])));
    assert.equal(p.decide(req(plain(9737, MOD))).action, "accept");
    t += 61_000;
    assert.equal(p.decide(req(plain(9737, MOD))).action, "reject");
  });

  test("only lists signed by the owner are trusted", () => {
    const p = strict();
    // A moderators list from someone else is not learned (and not even stored).
    const forged = modsList({ pubkey: STRANGER });
    assert.equal(p.decide(req(forged)).action, "reject");
    assert.equal(p.decide(req(plain(9737, MOD))).action, "reject");
    // Even an authorised moderator cannot extend the moderator list.
    p.decide(req(modsList()));
    const self = listEvent(D_MODERATORS, [{ pubkey: STRANGER, x25519: "c".repeat(64), from: 0 }], { pubkey: MOD });
    assert.equal(p.decide(req(self)).action, "accept"); // a moderator's own 30078 is storable…
    assert.equal(p.decide(req(plain(9737, STRANGER))).action, "reject"); // …but never trusted
  });

  test("keeps only the newest list and ignores events dated in the future", () => {
    const p = strict();
    p.decide(req(modsList({ createdAt: NOW - 100 })));
    // older list naming a stranger: stored by strfry rules, but not learned
    p.decide(
      req(listEvent(D_MODERATORS, [{ pubkey: STRANGER, x25519: "c".repeat(64), from: 0 }], { createdAt: NOW - 200 })),
    );
    assert.equal(p.decide(req(plain(9737, STRANGER))).action, "reject");
    assert.equal(p.decide(req(plain(9737, MOD))).action, "accept");
    // future-dated list (> now + 600 s) is ignored
    p.decide(req(listEvent(D_MODERATORS, [], { createdAt: NOW + 601 })));
    assert.equal(p.decide(req(plain(9737, MOD))).action, "accept");
    // a newer list that drops the moderator takes effect
    p.decide(req(listEvent(D_MODERATORS, [], { createdAt: NOW + 500 })));
    assert.equal(p.decide(req(plain(9737, MOD))).action, "reject");
  });

  test("malformed owner lists are not learned and never crash the plugin", () => {
    const p = strict();
    for (const content of ["not json", "{}", JSON.stringify({ schema: "x", name: "moderators", items: [] })]) {
      const e = { ...modsList(), content };
      assert.equal(p.decide(req(e)).action, "accept");
    }
    const wrongName = listEvent(D_MODERATORS, [{ pubkey: MOD, x25519: "a".repeat(64), from: 0 }], {
      name: "service-keys",
    });
    p.decide(req(wrongName));
    const badItems = listEvent(D_MODERATORS, [null, 5, { pubkey: "zz" }, { pubkey: MOD, until: -1 }]);
    p.decide(req(badItems));
    assert.equal(p.decide(req(plain(9737, MOD))).action, "reject");
    assert.deepEqual(learnFromEvent(emptyState(OWNER), { ...modsList(), tags: "nope" }, NOW), false);
    assert.equal(handleLine(p, JSON.stringify(req({ ...modsList(), tags: null }))).includes("accept"), true);
  });

  test("events from other relays follow the same kind and author rules", () => {
    const p = strict();
    p.decide(req(keysList(), "Stream"));
    assert.equal(p.decide(req(plain(30023, PUBLISHER), "Stream")).action, "accept");
    for (const src of ["Stream", "Sync", "Import"]) {
      assert.equal(p.decide(req(plain(30023, STRANGER), src)).action, "reject");
      assert.equal(p.decide(req(plain(5, OWNER), src)).action, "reject");
      assert.equal(p.decide(req(plain(1, PUBLISHER), src)).action, "reject");
      assert.equal(p.decide(req(ev({ bits: 3 }), src)).action, "reject");
    }
  });

  test("the owner cannot delete through the relay either", () => {
    const p = strict();
    assert.equal(p.decide(req(plain(5, OWNER))).action, "reject");
    assert.equal(p.decide(req(plain(62, OWNER))).action, "reject");
    assert.equal(p.decide(req(plain(27235, OWNER))).action, "reject");
  });

  test("comments and reactions from anyone still need PoW in strict mode", () => {
    const p = strict();
    assert.equal(p.decide(req(ev({ bits: 4 }))).action, "reject");
    assert.equal(p.decide(req(ev())).action, "accept");
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION }))).action, "accept");
  });
});

describe("persisted state", () => {
  test("survives a restart", () => {
    const file = tmpState();
    const a = strict({ stateFile: file });
    a.decide(req(modsList()));
    a.decide(req(keysList()));
    assert.ok(existsSync(file));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.owner, OWNER);
    assert.deepEqual(
      saved.lists[D_MODERATORS].items.map((i) => i.pubkey),
      [MOD, MOD_OLD],
    );
    const b = strict({ stateFile: file });
    assert.equal(b.decide(req(plain(9737, MOD))).action, "accept");
    assert.equal(b.decide(req(plain(30023, PUBLISHER))).action, "accept");
  });

  test("is ignored when it belongs to another owner", () => {
    const file = tmpState();
    strict({ stateFile: file }).decide(req(modsList()));
    const other = createPolicy({ ...defaults, ownerPubkey: "7".repeat(64), stateFile: file }, () => NOW_MS);
    assert.equal(other.decide(req(plain(9737, MOD))).action, "reject");
  });

  test("a corrupt or tampered file is ignored safely", () => {
    const file = tmpState();
    writeFileSync(file, "{ not json");
    const p = strict({ stateFile: file });
    assert.equal(p.decide(req(plain(9737, MOD))).action, "reject");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        owner: OWNER,
        lists: { [D_MODERATORS]: { createdAt: 1, id: "x", items: [{ pubkey: "bad" }] } },
      }),
    );
    assert.equal(strict({ stateFile: file }).decide(req(plain(9737, "bad"))).action, "reject");
  });

  test("plugin processes sharing the file see each other's updates", () => {
    const file = tmpState();
    const relayPlugin = strict({ stateFile: file });
    const streamPlugin = strict({ stateFile: file });
    assert.equal(relayPlugin.decide(req(plain(9737, MOD))).action, "reject");
    streamPlugin.decide(req(modsList(), "Stream"));
    assert.equal(relayPlugin.decide(req(plain(9737, MOD))).action, "accept");
    // and a later write by the first process does not lose the second one's lists
    relayPlugin.decide(req(keysList()));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(saved.lists[D_MODERATORS] && saved.lists[D_SERVICE_KEYS]);
  });

  test("ingestEvents replays lists from the database into the file", () => {
    const file = tmpState();
    const cfg = { ...defaults, ownerPubkey: OWNER, stateFile: file };
    const n = ingestEvents(cfg, [modsList(), keysList(), modsList({ pubkey: STRANGER }), plain(1, OWNER)], NOW);
    assert.equal(n, 2);
    assert.equal(strict({ stateFile: file }).decide(req(plain(9737, MOD))).action, "accept");
    assert.equal(ingestEvents({ ...cfg, ownerPubkey: "" }, [modsList()], NOW), 0);
  });

  test("bootstrap file: only owner moderators/service-keys lists go to strfry import", () => {
    const events = [
      modsList(),
      keysList(),
      modsList({ pubkey: STRANGER }),
      listEvent("azaad:list:relays", []),
      plain(1, OWNER),
    ];
    const lines = bootstrapLines(events, OWNER);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).id),
      [events[0].id, events[1].id],
    );
    assert.equal(parseEvents(JSON.stringify(events)).length, 5);
    assert.equal(parseEvents(lines.join("\n")).length, 2);
    assert.deepEqual(parseEvents(""), []);
  });
});

test("CLI helper modes: --owner-hex and --ingest", async () => {
  const file = tmpState();
  const env = {
    ...process.env,
    OWNER_PUBKEY: "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg",
    POLICY_STATE_FILE: file,
  };
  const run = (args, input = "") =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [POLICY, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
      child.stdin.end(input);
    });
  const hex = await run(["--owner-hex"]);
  assert.equal(hex.out.trim(), "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e");
  const owner = hex.out.trim();
  const mods = listEvent(D_MODERATORS, [{ pubkey: MOD, x25519: "a".repeat(64), from: 0 }], {
    pubkey: owner,
    createdAt: Math.floor(Date.now() / 1000) - 10,
  });
  const ing = await run(["--ingest", "-"], JSON.stringify(mods) + "\n");
  assert.equal(ing.code, 0);
  assert.match(ing.err, /learned 1 owner list update/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).lists[D_MODERATORS].items[0].pubkey, MOD);
  const bad = await new Promise((resolve) => {
    const child = spawn(process.execPath, [POLICY, "--owner-hex"], { env: { ...env, OWNER_PUBKEY: "nope" } });
    child.on("close", resolve);
  });
  assert.notEqual(bad, 0);
});
