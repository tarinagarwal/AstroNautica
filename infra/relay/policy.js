#!/usr/bin/env node
// AzaadAwaaz strfry write-policy plugin (spec §7, §12; threat model §3, §6).
//
// strfry starts this program once and keeps it running. For every event it
// wants to store it writes one JSON line on our stdin:
//   {"type":"new","event":{...},"receivedAt":...,"sourceType":"IP4","sourceInfo":"<ip>"}
// and expects one JSON line back on stdout:
//   {"id":"<event id>","action":"accept"|"reject"|"shadowReject","msg":"..."}
//
// strfry has already checked the event id and signature before calling us.
//
// Policy (an allowlist; every kind not named here is rejected):
//   - kind 5 (NIP-09 deletion) and kind 62 (NIP-62 request to vanish) are
//     always rejected: published copies must not be erasable through our relays.
//   - kind 27235 (NIP-98 HTTP auth) is never stored.
//   - kind 30023 (stories): only from the owner or a publisher key.
//   - kind 30078 (signed lists, storage receipts): only from the owner, a
//     current moderator or a publisher key.
//   - kind 9737 (moderation audit): only from the owner or a current moderator.
//   - kind 1111 (NIP-22 comment) and kind 7 (NIP-25 reaction) from anyone, with
//     NIP-13 proof-of-work (>= POW_DIFFICULTY leading zero bits AND a nonce tag
//     committing to a target >= POW_DIFFICULTY), per-pubkey rate limits over a
//     sliding 60 s window, and comments at most MAX_COMMENT_CHARS characters.
//
// Authorised keys: OWNER_PUBKEY (hex or npub) always. Moderators and publishers
// are learned from the owner's own list events as they pass through the relay
// (kind 30078, d = "azaad:list:moderators" / "azaad:list:service-keys"); only
// the newest event per list counts and events dated more than 10 minutes in
// the future are ignored. The learned state is persisted to POLICY_STATE_FILE
// (in the DB volume) so a restart keeps it; the entrypoint also replays the
// owner's list events already in the database (and BOOTSTRAP_LIST_EVENTS_FILE,
// imported through `strfry import`, which verifies signatures) at startup.
//
// Events that come from other relays (sourceType Stream/Sync/Import) follow the
// same kind and author rules; they only skip the per-key rate limits.
//
// With OWNER_PUBKEY unset the plugin runs in "open dev mode": it prints a loud
// warning and accepts kinds 30023, 30078 and 9737 from anyone (still rejecting
// deletions and everything else, and still enforcing proof-of-work). The
// production and mirror compose files require OWNER_PUBKEY.
//
// Privacy: this program never reads, stores or prints `sourceInfo` (the
// client IP). Nothing from the request is written to stderr either; the only
// diagnostics are fixed strings.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";

export const KIND_DELETION = 5;
export const KIND_REACTION = 7;
export const KIND_VANISH = 62;
export const KIND_COMMENT = 1111;
export const KIND_AUDIT = 9737;
export const KIND_HTTP_AUTH = 27235;
export const KIND_STORY = 30023;
export const KIND_APP_DATA = 30078;

export const D_MODERATORS = "azaad:list:moderators";
export const D_SERVICE_KEYS = "azaad:list:service-keys";
const LIST_NAMES = { [D_MODERATORS]: "moderators", [D_SERVICE_KEYS]: "service-keys" };
const LIST_SCHEMA = "azaadawaaz/list@1";
const MAX_FUTURE_SECONDS = 600;
const WINDOW_MS = 60_000;
const HEX32 = /^[0-9a-f]{64}$/;
const DEFAULT_STATE_FILE = "/app/strfry-db/policy-state.json";

function intFromEnv(env, name, fallback, min = 0, max = 256) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const value = Number.parseInt(String(raw).trim(), 10);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

// ------------------------------------------------------------------ bech32
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

/** Decodes an `npub1…` string to a 64-char hex public key; throws on anything else. */
export function npubToHex(npub) {
  const s = String(npub).trim().toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || s.length > 90) throw new Error("invalid bech32 string");
  const hrp = s.slice(0, sep);
  if (hrp !== "npub") throw new Error("not an npub");
  const data = [];
  for (const c of s.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) throw new Error("invalid bech32 character");
    data.push(v);
  }
  if (data.length < 6) throw new Error("invalid bech32 string");
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (bech32Polymod([...expanded, ...data]) !== 1) throw new Error("invalid bech32 checksum");
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 32) throw new Error("npub must encode 32 bytes");
  return Buffer.from(bytes).toString("hex");
}

/** Normalises OWNER_PUBKEY (hex or npub) to lowercase hex; "" when unset. Throws when malformed. */
export function parseOwnerPubkey(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  if (value.toLowerCase().startsWith("npub1")) return npubToHex(value);
  throw new Error("OWNER_PUBKEY must be a 64-character hex key or an npub");
}

/** Reads the policy configuration from environment variables. */
export function loadConfig(env = process.env) {
  return {
    powDifficulty: intFromEnv(env, "POW_DIFFICULTY", 16, 0, 256),
    commentsPerMinute: intFromEnv(env, "RATE_COMMENTS_PER_MINUTE", 10, 0, 1_000_000),
    reactionsPerMinute: intFromEnv(env, "RATE_REACTIONS_PER_MINUTE", 60, 0, 1_000_000),
    maxCommentChars: intFromEnv(env, "MAX_COMMENT_CHARS", 2000, 1, 10_000_000),
    // Events that reach the relay from another relay (strfry stream/router/sync)
    // or from `strfry import` were already policed where they were first
    // published; rate limits on those bulk paths would drop legitimate history.
    rateLimitTrustedSources: (env.RATE_LIMIT_TRUSTED_SOURCES ?? "false") === "true",
    ownerPubkey: parseOwnerPubkey(env.OWNER_PUBKEY),
    stateFile: env.POLICY_STATE_FILE === undefined ? DEFAULT_STATE_FILE : env.POLICY_STATE_FILE || null,
  };
}

/** Number of leading zero bits of a hex string (NIP-13). */
export function countLeadingZeroBits(hex) {
  let count = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = Number.parseInt(hex[i], 16);
    if (Number.isNaN(nibble)) return count;
    if (nibble === 0) {
      count += 4;
      continue;
    }
    count += Math.clz32(nibble) - 28;
    break;
  }
  return count;
}

/**
 * Checks NIP-13 proof-of-work. Returns null when it is sufficient, or a
 * human-readable reason (prefixed `pow:` per NIP-01) when it is not.
 */
export function checkPow(event, difficulty) {
  if (difficulty <= 0) return null;
  const id = typeof event.id === "string" ? event.id : "";
  if (!/^[0-9a-f]{64}$/.test(id)) return "pow: malformed event id";
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const nonce = tags.find((t) => Array.isArray(t) && t[0] === "nonce");
  if (!nonce) return `pow: missing nonce tag, difficulty ${difficulty} required`;
  if (nonce.length < 3 || !/^\d+$/.test(String(nonce[2]))) {
    return "pow: nonce tag must commit to a target difficulty";
  }
  const committed = Number.parseInt(String(nonce[2]), 10);
  if (committed < difficulty) {
    return `pow: committed target ${committed} is less than ${difficulty}`;
  }
  const actual = countLeadingZeroBits(id);
  if (actual < difficulty) {
    return `pow: difficulty ${actual} is less than ${difficulty}`;
  }
  return null;
}

/** Counts Unicode code points (what a reader sees as characters, near enough). */
export function codePointLength(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

const TRUSTED_SOURCES = new Set(["Import", "Stream", "Sync"]);

// ------------------------------------------------------- authorised keys

/** An empty learned state: `lists[d] = { createdAt, id, items }`. */
export function emptyState(owner) {
  return { version: 1, owner, lists: {} };
}

function dTag(event) {
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  const d = tags.find((t) => Array.isArray(t) && t[0] === "d");
  return d && typeof d[1] === "string" ? d[1] : null;
}

const isTime = (x) => Number.isInteger(x) && x >= 0;

/**
 * Extracts what the policy needs from an owner list event, or null when the
 * event is not a well-formed moderators / service-keys list.
 *   moderators   -> [{ pubkey, until? }]
 *   service-keys -> [{ pubkey }] for every role "publisher" entry (including
 *                   ones with `until`: their older events must stay storable)
 */
export function extractListItems(event) {
  const d = dTag(event);
  const name = LIST_NAMES[d];
  if (!name) return null;
  let content;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (content?.schema !== LIST_SCHEMA || content.name !== name || !Array.isArray(content.items)) return null;
  const items = [];
  for (const i of content.items) {
    if (typeof i !== "object" || i === null || typeof i.pubkey !== "string" || !HEX32.test(i.pubkey)) continue;
    if (name === "moderators") {
      if (i.until !== undefined && !isTime(i.until)) continue;
      items.push(i.until === undefined ? { pubkey: i.pubkey } : { pubkey: i.pubkey, until: i.until });
    } else if (i.role === "publisher") {
      items.push({ pubkey: i.pubkey });
    }
  }
  return { d, items };
}

function newer(a, b) {
  // NIP-01 replaceable events: the latest created_at wins; on a tie the lowest id.
  if (!b) return true;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id < b.id;
}

/**
 * Applies one event to the learned state if it is a newer, well-formed owner
 * list. Returns true when the state changed. The caller guarantees the
 * signature was verified (strfry does this before the plugin runs).
 */
export function learnFromEvent(state, event, nowSec) {
  if (!state.owner || event?.pubkey !== state.owner || event.kind !== KIND_APP_DATA) return false;
  if (!isTime(event.created_at) || event.created_at > nowSec + MAX_FUTURE_SECONDS) return false;
  if (typeof event.id !== "string" || !HEX32.test(event.id)) return false;
  const parsed = extractListItems(event);
  if (!parsed) return false;
  const entry = { createdAt: event.created_at, id: event.id, items: parsed.items };
  if (!newer(entry, state.lists[parsed.d])) return false;
  state.lists[parsed.d] = entry;
  return true;
}

/** Merges `other` into `state` (newest list wins). Returns true when `state` changed. */
export function mergeState(state, other) {
  if (!other || other.owner !== state.owner || typeof other.lists !== "object" || other.lists === null) return false;
  let changed = false;
  for (const d of Object.keys(LIST_NAMES)) {
    const e = other.lists[d];
    if (!e || !isTime(e.createdAt) || typeof e.id !== "string" || !Array.isArray(e.items)) continue;
    const items = e.items.filter(
      (i) => i && typeof i.pubkey === "string" && HEX32.test(i.pubkey) && (i.until === undefined || isTime(i.until)),
    );
    const entry = { createdAt: e.createdAt, id: e.id, items };
    if (newer(entry, state.lists[d])) {
      state.lists[d] = entry;
      changed = true;
    }
  }
  return changed;
}

/** File-backed persistence for the learned state, shared by every plugin process on the relay. */
export function createStateStore(path) {
  let seen = null; // "<inode>:<mtimeMs>:<size>" of the file version last read or written

  function stamp() {
    try {
      const s = statSync(path);
      return `${s.ino}:${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  }

  function read() {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  return {
    /** Merges the file into `state` if it changed since we last looked. Returns true when `state` changed. */
    refresh(state) {
      const now = stamp();
      if (now === null || now === seen) return false;
      seen = now;
      return mergeState(state, read());
    },
    /** Writes `state` (merged with whatever another process wrote meanwhile) atomically. */
    save(state) {
      mergeState(state, read());
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
      renameSync(tmp, path);
      seen = stamp();
    },
  };
}

/**
 * Creates a stateful policy. `now` returns the current time in milliseconds
 * (injectable for tests).
 */
export function createPolicy(config, now = () => Date.now()) {
  // key "<kind>:<pubkey>" -> array of accepted timestamps (ms), oldest first
  const history = new Map();
  let lastSweep = now();
  const owner = config.ownerPubkey || "";
  const openMode = !owner;
  const state = emptyState(owner);
  const store = !openMode && config.stateFile ? createStateStore(config.stateFile) : null;

  function refresh() {
    if (!store) return;
    try {
      store.refresh(state);
    } catch {
      process.stderr.write("azaad-policy: cannot read the policy state file\n");
    }
  }
  refresh();

  function persist() {
    if (!store) return;
    try {
      store.save(state);
    } catch {
      process.stderr.write("azaad-policy: cannot write the policy state file\n");
    }
  }

  function moderators(nowSec) {
    const items = state.lists[D_MODERATORS]?.items ?? [];
    return new Set(items.filter((m) => m.until === undefined || m.until > nowSec).map((m) => m.pubkey));
  }

  function publishers() {
    return new Set((state.lists[D_SERVICE_KEYS]?.items ?? []).map((k) => k.pubkey));
  }

  function sweep(t) {
    if (t - lastSweep < WINDOW_MS) return;
    lastSweep = t;
    for (const [key, stamps] of history) {
      while (stamps.length && t - stamps[0] >= WINDOW_MS) stamps.shift();
      if (!stamps.length) history.delete(key);
    }
  }

  function limitFor(kind) {
    return kind === KIND_COMMENT ? config.commentsPerMinute : config.reactionsPerMinute;
  }

  const ACCEPT = { action: "accept", msg: "" };
  const blocked = (msg) => ({ action: "reject", msg: `blocked: ${msg}` });

  /** Kinds 30023 / 30078 / 9737: author must be authorised. */
  function decidePrivileged(event, t) {
    const kind = event.kind;
    const author = typeof event.pubkey === "string" ? event.pubkey : "";
    if (openMode) return ACCEPT;
    if (author === owner) {
      if (kind === KIND_APP_DATA) {
        refresh();
        if (learnFromEvent(state, event, Math.floor(t / 1000))) persist();
      }
      return ACCEPT;
    }
    refresh();
    const nowSec = Math.floor(t / 1000);
    if (kind === KIND_STORY) {
      return publishers().has(author) ? ACCEPT : blocked("stories are accepted only from publisher keys");
    }
    if (kind === KIND_AUDIT) {
      return moderators(nowSec).has(author) ? ACCEPT : blocked("audit events are accepted only from moderators");
    }
    if (moderators(nowSec).has(author) || publishers().has(author)) return ACCEPT;
    return blocked("app data is accepted only from the owner, moderators and publisher keys");
  }

  /** Kinds 1111 / 7: PoW, rate limits, comment length. */
  function decideSocial(request, t) {
    const event = request.event;
    const kind = event.kind;
    if (kind === KIND_COMMENT) {
      const content = typeof event.content === "string" ? event.content : "";
      if (codePointLength(content) > config.maxCommentChars) {
        return {
          action: "reject",
          msg: `invalid: comment longer than ${config.maxCommentChars} characters`,
        };
      }
    }

    const powError = checkPow(event, config.powDifficulty);
    if (powError) return { action: "reject", msg: powError };

    const trusted = TRUSTED_SOURCES.has(request.sourceType);
    if (trusted && !config.rateLimitTrustedSources) return ACCEPT;

    sweep(t);
    const key = `${kind}:${event.pubkey}`;
    let stamps = history.get(key);
    if (!stamps) {
      stamps = [];
      history.set(key, stamps);
    }
    while (stamps.length && t - stamps[0] >= WINDOW_MS) stamps.shift();
    const limit = limitFor(kind);
    if (stamps.length >= limit) {
      const what = kind === KIND_COMMENT ? "comments" : "reactions";
      return { action: "reject", msg: `rate-limited: at most ${limit} ${what} per minute` };
    }
    stamps.push(t);
    return ACCEPT;
  }

  /** Returns {action, msg}. Never inspects request.sourceInfo. */
  function decide(request) {
    const event = request.event;
    const kind = event?.kind;
    switch (kind) {
      case KIND_DELETION:
      case KIND_VANISH:
        return blocked("deletion requests are not accepted; published copies stay available");
      case KIND_HTTP_AUTH:
        return blocked("HTTP auth events are never stored");
      case KIND_STORY:
      case KIND_APP_DATA:
      case KIND_AUDIT:
        return decidePrivileged(event, now());
      case KIND_COMMENT:
      case KIND_REACTION:
        return decideSocial(request, now());
      default:
        return blocked(`kind ${Number.isInteger(kind) ? kind : "?"} is not accepted by this relay`);
    }
  }

  return { decide, openMode, _history: history, _state: state };
}

/**
 * Handles one input line from strfry. Returns the output line (without
 * newline), or null when no reply is due.
 */
export function handleLine(policy, line) {
  if (!line.trim()) return null;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stderr.write("azaad-policy: unparseable input line\n");
    return null;
  }
  if (request?.type !== "new") return null; // e.g. legacy "lookback" lines
  const id = request?.event?.id;
  if (typeof id !== "string") {
    process.stderr.write("azaad-policy: input without event id\n");
    return null;
  }
  let decision;
  try {
    decision = policy.decide(request);
  } catch {
    decision = { action: "reject", msg: "error: policy failure" };
  }
  const out = { id, action: decision.action };
  if (decision.msg) out.msg = decision.msg;
  return JSON.stringify(out);
}

/** Parses a JSON array or JSON-lines text into events (non-objects dropped). */
export function parseEvents(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error("expected a JSON array of events");
    return arr.filter((e) => e && typeof e === "object");
  }
  return trimmed
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e && typeof e === "object");
}

/**
 * The owner's moderators / service-keys list events from a bootstrap file, as
 * JSON lines for `strfry import` (which verifies their signatures).
 */
export function bootstrapLines(events, owner) {
  return events
    .filter((e) => e.pubkey === owner && e.kind === KIND_APP_DATA && LIST_NAMES[dTag(e)])
    .map((e) => JSON.stringify(e));
}

/**
 * Learns from events read from strfry's own database (`strfry scan`; their
 * signatures were verified when they were stored) and saves the state file.
 * Returns the number of lists updated.
 */
export function ingestEvents(config, events, nowSec = Math.floor(Date.now() / 1000)) {
  if (!config.ownerPubkey || !config.stateFile) return 0;
  const state = emptyState(config.ownerPubkey);
  const store = createStateStore(config.stateFile);
  store.refresh(state);
  let changed = 0;
  for (const e of events) if (learnFromEvent(state, e, nowSec)) changed++;
  store.save(state);
  return changed;
}

function summary(state) {
  const mods = state.lists[D_MODERATORS]?.items.length ?? 0;
  const pubs = state.lists[D_SERVICE_KEYS]?.items.length ?? 0;
  return `${mods} moderator entries, ${pubs} publisher keys`;
}

export function main(argv = process.argv.slice(2)) {
  const config = loadConfig();

  // Helper modes used by the entrypoint before strfry starts.
  if (argv[0] === "--owner-hex") {
    process.stdout.write(config.ownerPubkey + "\n");
    return;
  }
  if (argv[0] === "--bootstrap-lines") {
    const lines = bootstrapLines(parseEvents(readFileSync(argv[1], "utf8")), config.ownerPubkey);
    if (lines.length) process.stdout.write(lines.join("\n") + "\n");
    process.stderr.write(`azaad-policy: ${lines.length} bootstrap list event(s) handed to strfry import\n`);
    return;
  }
  if (argv[0] === "--ingest") {
    const text = readFileSync(argv[1] === "-" || !argv[1] ? 0 : argv[1], "utf8");
    const n = ingestEvents(config, parseEvents(text));
    process.stderr.write(`azaad-policy: learned ${n} owner list update(s) from the database\n`);
    return;
  }

  const policy = createPolicy(config);
  if (policy.openMode) {
    process.stderr.write(
      "azaad-policy: WARNING ******************************************************\n" +
        "azaad-policy: WARNING OWNER_PUBKEY is not set: OPEN DEV MODE. Stories, lists and\n" +
        "azaad-policy: WARNING audit events are accepted from ANY key. Never run a public\n" +
        "azaad-policy: WARNING relay like this; set OWNER_PUBKEY (hex or npub).\n" +
        "azaad-policy: WARNING ******************************************************\n",
    );
  }
  process.stderr.write(
    `azaad-policy: started (pow=${config.powDifficulty}, comments/min=${config.commentsPerMinute}, ` +
      `reactions/min=${config.reactionsPerMinute}, maxCommentChars=${config.maxCommentChars}, ` +
      `owner=${policy.openMode ? "unset" : config.ownerPubkey.slice(0, 12) + "…"}, ${summary(policy._state)})\n`,
  );
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const out = handleLine(policy, line);
    if (out !== null) process.stdout.write(out + "\n");
  });
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
