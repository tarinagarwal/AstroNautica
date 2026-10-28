import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../scrub-ips.js';

test('removes IPv4 and IPv6 addresses', () => {
  assert.equal(scrub('[Websocket] Connect from 172.18.0.1'), '[Websocket] Connect from [ip]');
  assert.equal(scrub('peer [2001:db8::1]:443 and ::1'), 'peer [[ip]]:443 and [ip]');
  assert.equal(scrub('fe80:0:0:0:1:2:3:4 gone'), '[ip] gone');
  assert.equal(scrub('mapped ::ffff:10.0.0.1'), 'mapped [ip]');
});

test('keeps timestamps and ordinary text', () => {
  const line = '2026-10-28 00:01:02.123 (   1.234s) [Ingester 1]  INFO| Inserted event. id=00ab kind=1111';
  assert.equal(scrub(line), line);
});
