/**
 * The reader's key for comments and reactions (spec §7): created silently on first use, kept in IndexedDB, and
 * exportable / importable as an nsec. Readers are offered a backup after it is created.
 */
import { generateKeyPair, keyPairFromSecret, parseSecretKey, type KeyPair } from "@core/keys.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { idbDel, idbGet, idbSet } from "./idb.js";

interface Stored {
  secret: string;
  createdAt: number;
  backedUp: boolean;
}

const KEY = "reader:key";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function onReaderKeyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function getReaderKey(): Promise<(KeyPair & { backedUp: boolean }) | undefined> {
  const s = await idbGet<Stored>(KEY);
  if (!s) return undefined;
  return { ...keyPairFromSecret(hexToBytes(s.secret)), backedUp: s.backedUp };
}

/** The reader key, creating it on first use. `created` tells the caller to offer a backup. */
export async function ensureReaderKey(): Promise<{ key: KeyPair; created: boolean }> {
  const existing = await getReaderKey();
  if (existing) return { key: existing, created: false };
  const key = generateKeyPair();
  await idbSet(KEY, { secret: bytesToHex(key.secretKey), createdAt: Date.now(), backedUp: false } satisfies Stored);
  notify();
  return { key, created: true };
}

export async function importReaderKey(input: string): Promise<KeyPair> {
  const key = keyPairFromSecret(parseSecretKey(input));
  await idbSet(KEY, { secret: bytesToHex(key.secretKey), createdAt: Date.now(), backedUp: true } satisfies Stored);
  notify();
  return key;
}

export async function markBackedUp(): Promise<void> {
  const s = await idbGet<Stored>(KEY);
  if (s) await idbSet(KEY, { ...s, backedUp: true });
  notify();
}

export async function forgetReaderKey(): Promise<void> {
  await idbDel(KEY);
  notify();
}
