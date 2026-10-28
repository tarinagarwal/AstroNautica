#!/usr/bin/env node
// Line filter that removes IP addresses from log output (spec §12: no IP
// logging). strfry prints the client address when a websocket connects and has
// no switch to stop it, so its output is piped through this before it reaches
// the container log.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// "::"-compressed forms (::1, 2001:db8::1, ::ffff:...) - timestamps never contain "::"
const IPV6_COMPRESSED = /[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4})*::[0-9A-Fa-f:.]*/g;
// full forms need at least 4 groups; HH:MM:SS timestamps have only 3
const IPV6_FULL = /\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b/g;

export function scrub(line) {
  return line.replace(IPV6_COMPRESSED, "[ip]").replace(IPV6_FULL, "[ip]").replace(IPV4, "[ip]");
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => process.stdout.write(scrub(line) + "\n"));
}
