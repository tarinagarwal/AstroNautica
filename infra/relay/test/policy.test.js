import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  countLeadingZeroBits,
  checkPow,
  codePointLength,
  createPolicy,
  handleLine,
  loadConfig,
  KIND_COMMENT,
  KIND_REACTION,
} from '../policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = join(here, '..', 'policy.js');

/** A 64-char hex id with exactly `bits` leading zero bits. */
function idWithBits(bits, salt = 0) {
  const zeroNibbles = Math.floor(bits / 4);
  const rem = bits % 4;
  // first non-zero nibble: rem leading zeros inside it -> 8>>rem (8,4,2,1)
  const nibble = (8 >> rem).toString(16);
  const tail = salt.toString(16).padStart(64, 'f');
  return ('0'.repeat(zeroNibbles) + nibble + tail).slice(0, 64);
}

const PUB_A = 'a'.repeat(64);
const PUB_B = 'b'.repeat(64);
let counter = 0;

function ev({ kind = KIND_COMMENT, bits = 16, target = 16, content = 'hello', pubkey = PUB_A, nonce = true } = {}) {
  counter++;
  const tags = [['e', 'c'.repeat(64)]];
  if (nonce) tags.push(target === null ? ['nonce', '123'] : ['nonce', String(counter), String(target)]);
  return { id: idWithBits(bits, counter), pubkey, kind, content, tags, created_at: 1, sig: 'd'.repeat(128) };
}

function req(event, sourceType = 'IP4') {
  return { type: 'new', event, receivedAt: 1, sourceType, sourceInfo: '203.0.113.9' };
}

const defaults = loadConfig({});

describe('countLeadingZeroBits', () => {
  test('matches NIP-13 examples', () => {
    assert.equal(countLeadingZeroBits('000000000e9d97a1ab09fc381030b346cdd7a142ad57e6df0b46dc9bef6c7e2d'), 36);
    assert.equal(countLeadingZeroBits('ff'), 0);
    assert.equal(countLeadingZeroBits('7f'), 1);
    assert.equal(countLeadingZeroBits('3f'), 2);
    assert.equal(countLeadingZeroBits('1f'), 3);
    assert.equal(countLeadingZeroBits('0f'), 4);
    assert.equal(countLeadingZeroBits('0'.repeat(64)), 256);
  });
  test('helper builds ids with the requested bits', () => {
    for (const b of [0, 1, 5, 15, 16, 17, 20, 31]) assert.equal(countLeadingZeroBits(idWithBits(b)), b);
  });
});

describe('loadConfig', () => {
  test('defaults follow the spec', () => {
    assert.deepEqual(defaults, {
      powDifficulty: 16,
      commentsPerMinute: 10,
      reactionsPerMinute: 60,
      maxCommentChars: 2000,
      rateLimitTrustedSources: false,
    });
  });
  test('reads overrides', () => {
    const c = loadConfig({ POW_DIFFICULTY: '20', RATE_COMMENTS_PER_MINUTE: '3', RATE_REACTIONS_PER_MINUTE: '5', MAX_COMMENT_CHARS: '50' });
    assert.equal(c.powDifficulty, 20);
    assert.equal(c.commentsPerMinute, 3);
    assert.equal(c.reactionsPerMinute, 5);
    assert.equal(c.maxCommentChars, 50);
  });
  test('rejects garbage', () => {
    assert.throws(() => loadConfig({ POW_DIFFICULTY: 'abc' }));
    assert.throws(() => loadConfig({ POW_DIFFICULTY: '-1' }));
    assert.throws(() => loadConfig({ POW_DIFFICULTY: '300' }));
  });
});

describe('checkPow', () => {
  test('accepts enough work with a matching commitment', () => {
    assert.equal(checkPow(ev({ bits: 16, target: 16 }), 16), null);
    assert.equal(checkPow(ev({ bits: 21, target: 18 }), 16), null);
  });
  test('rejects too little work', () => {
    assert.match(checkPow(ev({ bits: 15, target: 16 }), 16), /^pow: difficulty 15 is less than 16/);
  });
  test('rejects a low commitment even when the id happens to be lucky', () => {
    assert.match(checkPow(ev({ bits: 20, target: 8 }), 16), /^pow: committed target 8 is less than 16/);
  });
  test('rejects a missing nonce tag or missing commitment', () => {
    assert.match(checkPow(ev({ bits: 20, nonce: false }), 16), /^pow: missing nonce tag/);
    assert.match(checkPow(ev({ bits: 20, target: null }), 16), /^pow: nonce tag must commit/);
  });
  test('difficulty 0 disables the check', () => {
    assert.equal(checkPow(ev({ bits: 0, nonce: false }), 0), null);
  });
});

describe('createPolicy', () => {
  test('accepts other kinds untouched (no PoW, no limits)', () => {
    const p = createPolicy(defaults);
    for (const kind of [0, 1, 3, 5, 30023, 30078, 10002]) {
      for (let i = 0; i < 100; i++) {
        assert.equal(p.decide(req(ev({ kind, bits: 0, nonce: false, content: 'x'.repeat(5000) }))).action, 'accept');
      }
    }
  });

  test('requires PoW on comments and reactions', () => {
    const p = createPolicy(defaults);
    assert.equal(p.decide(req(ev({ kind: KIND_COMMENT, bits: 8, target: 16 }))).action, 'reject');
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, bits: 8, target: 16 }))).action, 'reject');
    assert.equal(p.decide(req(ev({ kind: KIND_COMMENT, bits: 16, target: 16 }))).action, 'accept');
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, bits: 16, target: 16 }))).action, 'accept');
  });

  test('comment length is counted in characters, limit inclusive', () => {
    const p = createPolicy(defaults);
    assert.equal(p.decide(req(ev({ content: 'x'.repeat(2000) }))).action, 'accept');
    const long = p.decide(req(ev({ content: 'x'.repeat(2001) })));
    assert.equal(long.action, 'reject');
    assert.match(long.msg, /^invalid: comment longer than 2000/);
    // Devanagari and emoji: 2000 code points but many more UTF-8 bytes / UTF-16 units
    const hindi = 'न'.repeat(1000) + '🙏'.repeat(1000);
    assert.equal(codePointLength(hindi), 2000);
    assert.equal(p.decide(req(ev({ content: hindi, pubkey: PUB_B }))).action, 'accept');
  });

  test('length is not enforced on reactions', () => {
    const p = createPolicy(defaults);
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, content: 'x'.repeat(3000) }))).action, 'accept');
  });

  test('rate-limits comments per pubkey per minute', () => {
    let t = 1_000_000;
    const p = createPolicy(defaults, () => t);
    for (let i = 0; i < 10; i++) assert.equal(p.decide(req(ev({ pubkey: PUB_A }))).action, 'accept', `comment ${i}`);
    const r = p.decide(req(ev({ pubkey: PUB_A })));
    assert.equal(r.action, 'reject');
    assert.match(r.msg, /^rate-limited: at most 10 comments per minute/);
    // another key is unaffected
    assert.equal(p.decide(req(ev({ pubkey: PUB_B }))).action, 'accept');
    // reactions from the limited key use their own bucket
    assert.equal(p.decide(req(ev({ kind: KIND_REACTION, pubkey: PUB_A }))).action, 'accept');
    // sliding window
    t += 59_999;
    assert.equal(p.decide(req(ev({ pubkey: PUB_A }))).action, 'reject');
    t += 1;
    assert.equal(p.decide(req(ev({ pubkey: PUB_A }))).action, 'accept');
  });

  test('rate-limits reactions at 60/minute', () => {
    let t = 0;
    const p = createPolicy(defaults, () => t);
    for (let i = 0; i < 60; i++) {
      t += 10;
      assert.equal(p.decide(req(ev({ kind: KIND_REACTION }))).action, 'accept');
    }
    assert.match(p.decide(req(ev({ kind: KIND_REACTION }))).msg, /^rate-limited: at most 60 reactions/);
  });

  test('rejected events do not use up the allowance', () => {
    const p = createPolicy({ ...defaults, commentsPerMinute: 2 });
    for (let i = 0; i < 5; i++) assert.equal(p.decide(req(ev({ bits: 1 }))).action, 'reject');
    assert.equal(p.decide(req(ev())).action, 'accept');
    assert.equal(p.decide(req(ev())).action, 'accept');
    assert.equal(p.decide(req(ev())).action, 'reject');
  });

  test('relay-to-relay sources skip rate limits but not PoW', () => {
    const p = createPolicy({ ...defaults, commentsPerMinute: 1 });
    for (let i = 0; i < 5; i++) assert.equal(p.decide(req(ev(), 'Stream')).action, 'accept');
    assert.equal(p.decide(req(ev({ bits: 3 }), 'Sync')).action, 'reject');
    const strict = createPolicy({ ...defaults, commentsPerMinute: 1, rateLimitTrustedSources: true });
    assert.equal(strict.decide(req(ev(), 'Stream')).action, 'accept');
    assert.equal(strict.decide(req(ev(), 'Stream')).action, 'reject');
  });

  test('old history is swept', () => {
    let t = 0;
    const p = createPolicy(defaults, () => t);
    for (let i = 0; i < 50; i++) p.decide(req(ev({ pubkey: i.toString(16).padStart(64, '0') })));
    assert.equal(p._history.size, 50);
    t += 120_000;
    p.decide(req(ev({ pubkey: PUB_A })));
    assert.equal(p._history.size, 1);
  });
});

describe('handleLine', () => {
  const p = createPolicy(defaults);
  test('answers with id/action/msg and never echoes the source IP', () => {
    const bad = ev({ bits: 2 });
    const out = handleLine(p, JSON.stringify(req(bad)));
    const parsed = JSON.parse(out);
    assert.equal(parsed.id, bad.id);
    assert.equal(parsed.action, 'reject');
    assert.ok(parsed.msg.startsWith('pow:'));
    assert.ok(!out.includes('203.0.113.9'));
    const good = ev();
    assert.deepEqual(JSON.parse(handleLine(p, JSON.stringify(req(good)))), { id: good.id, action: 'accept' });
  });
  test('ignores blank lines and non-"new" requests', () => {
    assert.equal(handleLine(p, ''), null);
    assert.equal(handleLine(p, JSON.stringify({ type: 'lookback', event: ev() })), null);
  });
});

test('runs as a strfry plugin over stdin/stdout without logging the IP', async () => {
  const child = spawn(process.execPath, [POLICY], {
    env: { ...process.env, POW_DIFFICULTY: '16', RATE_COMMENTS_PER_MINUTE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const events = [ev({ bits: 4 }), ev(), ev(), ev({ kind: 1, bits: 0, nonce: false })];
  child.stdin.write('not json\n');
  for (const e of events) child.stdin.write(JSON.stringify(req(e)) + '\n');
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.id, l.action]),
    [
      [events[0].id, 'reject'],
      [events[1].id, 'accept'],
      [events[2].id, 'reject'],
      [events[3].id, 'accept'],
    ],
  );
  assert.match(lines[2].msg, /^rate-limited/);
  assert.ok(!stdout.includes('203.0.113.9'));
  assert.ok(!stderr.includes('203.0.113.9'));
  assert.match(stderr, /azaad-policy: started \(pow=16, comments\/min=1/);
});
