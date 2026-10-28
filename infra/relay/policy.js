#!/usr/bin/env node
// AzaadAwaaz strfry write-policy plugin (spec §7, §12).
//
// strfry starts this program once and keeps it running. For every event it
// wants to store it writes one JSON line on our stdin:
//   {"type":"new","event":{...},"receivedAt":...,"sourceType":"IP4","sourceInfo":"<ip>"}
// and expects one JSON line back on stdout:
//   {"id":"<event id>","action":"accept"|"reject"|"shadowReject","msg":"..."}
//
// strfry has already checked the event id and signature before calling us.
//
// Policy:
//   - kind 1111 (NIP-22 comment) and kind 7 (NIP-25 reaction) need NIP-13
//     proof-of-work: the event id must have >= POW_DIFFICULTY leading zero bits
//     AND the nonce tag must commit to a target >= POW_DIFFICULTY.
//   - per-pubkey rate limits over a sliding 60 s window (comments and
//     reactions counted separately).
//   - comment content is at most MAX_COMMENT_CHARS characters (Unicode code points).
//   - every other kind is accepted.
//
// Privacy: this program never reads, stores or prints `sourceInfo` (the
// client IP). Nothing from the request is written to stderr either; the only
// diagnostics are fixed strings.

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const KIND_REACTION = 7;
export const KIND_COMMENT = 1111;
const WINDOW_MS = 60_000;

function intFromEnv(env, name, fallback, min = 0, max = 256) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const value = Number.parseInt(String(raw).trim(), 10);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

/** Reads the policy configuration from environment variables. */
export function loadConfig(env = process.env) {
  return {
    powDifficulty: intFromEnv(env, 'POW_DIFFICULTY', 16, 0, 256),
    commentsPerMinute: intFromEnv(env, 'RATE_COMMENTS_PER_MINUTE', 10, 0, 1_000_000),
    reactionsPerMinute: intFromEnv(env, 'RATE_REACTIONS_PER_MINUTE', 60, 0, 1_000_000),
    maxCommentChars: intFromEnv(env, 'MAX_COMMENT_CHARS', 2000, 1, 10_000_000),
    // Events that reach the relay from another relay (strfry stream/router/sync)
    // or from `strfry import` were already policed where they were first
    // published; rate limits on those bulk paths would drop legitimate history.
    rateLimitTrustedSources: (env.RATE_LIMIT_TRUSTED_SOURCES ?? 'false') === 'true',
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
  const id = typeof event.id === 'string' ? event.id : '';
  if (!/^[0-9a-f]{64}$/.test(id)) return 'pow: malformed event id';
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const nonce = tags.find((t) => Array.isArray(t) && t[0] === 'nonce');
  if (!nonce) return `pow: missing nonce tag, difficulty ${difficulty} required`;
  if (nonce.length < 3 || !/^\d+$/.test(String(nonce[2]))) {
    return 'pow: nonce tag must commit to a target difficulty';
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

const TRUSTED_SOURCES = new Set(['Import', 'Stream', 'Sync']);

/**
 * Creates a stateful policy. `now` returns the current time in milliseconds
 * (injectable for tests).
 */
export function createPolicy(config, now = () => Date.now()) {
  // key "<kind>:<pubkey>" -> array of accepted timestamps (ms), oldest first
  const history = new Map();
  let lastSweep = now();

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

  /** Returns {action, msg}. Never inspects request.sourceInfo. */
  function decide(request) {
    const event = request.event;
    const kind = event.kind;
    if (kind !== KIND_COMMENT && kind !== KIND_REACTION) {
      return { action: 'accept', msg: '' };
    }

    if (kind === KIND_COMMENT) {
      const content = typeof event.content === 'string' ? event.content : '';
      if (codePointLength(content) > config.maxCommentChars) {
        return {
          action: 'reject',
          msg: `invalid: comment longer than ${config.maxCommentChars} characters`,
        };
      }
    }

    const powError = checkPow(event, config.powDifficulty);
    if (powError) return { action: 'reject', msg: powError };

    const trusted = TRUSTED_SOURCES.has(request.sourceType);
    if (trusted && !config.rateLimitTrustedSources) {
      return { action: 'accept', msg: '' };
    }

    const t = now();
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
      const what = kind === KIND_COMMENT ? 'comments' : 'reactions';
      return { action: 'reject', msg: `rate-limited: at most ${limit} ${what} per minute` };
    }
    stamps.push(t);
    return { action: 'accept', msg: '' };
  }

  return { decide, _history: history };
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
    process.stderr.write('azaad-policy: unparseable input line\n');
    return null;
  }
  if (request?.type !== 'new') return null; // e.g. legacy "lookback" lines
  const id = request?.event?.id;
  if (typeof id !== 'string') {
    process.stderr.write('azaad-policy: input without event id\n');
    return null;
  }
  let decision;
  try {
    decision = policy.decide(request);
  } catch {
    decision = { action: 'reject', msg: 'error: policy failure' };
  }
  const out = { id, action: decision.action };
  if (decision.msg) out.msg = decision.msg;
  return JSON.stringify(out);
}

export function main() {
  const config = loadConfig();
  const policy = createPolicy(config);
  process.stderr.write(
    `azaad-policy: started (pow=${config.powDifficulty}, comments/min=${config.commentsPerMinute}, ` +
      `reactions/min=${config.reactionsPerMinute}, maxCommentChars=${config.maxCommentChars})\n`,
  );
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const out = handleLine(policy, line);
    if (out !== null) process.stdout.write(out + '\n');
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
