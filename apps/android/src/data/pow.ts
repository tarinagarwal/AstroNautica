/**
 * NIP-13 proof-of-work for comments and reactions (spec §7). The heavy loop runs natively on a background thread:
 * the event is serialised exactly as nostr-tools hashes it, with a placeholder where the nonce goes, and native code
 * only iterates the nonce. Without the native miner (tests, or if it fails) core's `mineAndSign` runs in chunks
 * that yield to the UI.
 */
import { mineAndSign } from "@azaadawaaz/core";
import { getPow } from "nostr-tools/nip13";
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";

export interface NativeMiner {
  mine(jobId: string, prefix: string, suffix: string, difficulty: number, startNonce: number): Promise<string>;
  cancel(jobId: string): void;
}

/** The exact string nostr-tools hashes for an event id (NIP-01 serialisation). */
export function serializeForId(e: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

/** Split the serialisation around the nonce value so prefix + nonce + suffix is exactly what gets hashed. */
export function powParts(
  template: EventTemplate,
  pubkey: string,
  difficulty: number,
): { prefix: string; suffix: string; tags: (n: string) => string[][] } {
  const base = template.tags.filter((t) => t[0] !== "nonce");
  let marker = "AZAAD_NONCE_PLACEHOLDER";
  while (JSON.stringify(template).includes(marker)) marker += "_";
  const tags = (n: string) => [...base, ["nonce", n, String(difficulty)]];
  const s = serializeForId({ ...template, pubkey, tags: tags(marker) });
  const at = s.indexOf(marker);
  return { prefix: s.slice(0, at), suffix: s.slice(at + marker.length), tags };
}

let jobs = 0;

export async function mineEvent(
  template: EventTemplate,
  secretKey: Uint8Array,
  difficulty: number,
  native?: NativeMiner,
  signal?: AbortSignal,
): Promise<Event> {
  if (difficulty <= 0) return finalizeEvent(template, secretKey);
  if (native) {
    const pubkey = getPublicKey(secretKey);
    const job = `pow-${++jobs}`;
    const onAbort = () => native.cancel(job);
    signal?.addEventListener("abort", onAbort);
    try {
      const fixed = { ...template, created_at: template.created_at };
      const { prefix, suffix, tags } = powParts(fixed, pubkey, difficulty);
      const nonce = await native.mine(job, prefix, suffix, difficulty, 0);
      const event = finalizeEvent({ ...fixed, tags: tags(nonce) }, secretKey);
      if (getPow(event.id) >= difficulty) return event;
      // Should never happen; fall through to the JS miner rather than publish an event without enough work.
    } catch (e) {
      if (signal?.aborted) throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return mineAndSign(template, secretKey, difficulty, { signal, yieldEvery: 2000 });
}
