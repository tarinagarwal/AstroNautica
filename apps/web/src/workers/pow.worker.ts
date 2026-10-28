/// <reference lib="webworker" />
// NIP-13 proof-of-work for comments and reactions, off the main thread (spec §7).
import { mineAndSign } from "@core/social.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { EventTemplate } from "nostr-tools/pure";

interface Job {
  template: EventTemplate;
  secretKeyHex: string;
  difficulty: number;
}

self.onmessage = async (msg: MessageEvent<Job>) => {
  const { template, secretKeyHex, difficulty } = msg.data;
  try {
    const event = await mineAndSign(template, hexToBytes(secretKeyHex), difficulty, { yieldEvery: 20_000 });
    (self as unknown as Worker).postMessage({ ok: true, event });
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
