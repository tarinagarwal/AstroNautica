import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { generateSecretKey, getEventHash, getPublicKey, type Event } from "nostr-tools/pure";

export interface KeyPair {
  /** 32-byte secret key. */
  secretKey: Uint8Array;
  /** x-only public key as lowercase hex (Nostr convention). */
  pubkey: string;
  npub: string;
  nsec: string;
}

export function generateKeyPair(): KeyPair {
  return keyPairFromSecret(generateSecretKey());
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: nip19.npubEncode(pubkey), nsec: nip19.nsecEncode(secretKey) };
}

/** Accept an `nsec…` string or 64-char hex secret. */
export function parseSecretKey(input: string): Uint8Array {
  const s = input.trim();
  if (s.startsWith("nsec1")) {
    const d = nip19.decode(s);
    if (d.type !== "nsec") throw new Error("not an nsec");
    return d.data;
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBytes(s.toLowerCase());
  throw new Error("expected an nsec or a 64-character hex secret key");
}

export function npubToHex(npub: string): string {
  const d = nip19.decode(npub);
  if (d.type !== "npub") throw new Error(`not an npub: ${npub}`);
  return d.data;
}

export function hexToNpub(hex: string): string {
  return nip19.npubEncode(hex);
}

/** Accept either an npub or a hex public key; return hex. */
export function toPubkeyHex(key: string): string {
  return key.startsWith("npub1") ? npubToHex(key) : key.toLowerCase();
}

/** BIP-340 Schnorr signature over a 32-byte message given as hex. */
export function signHash(messageHashHex: string, secretKey: Uint8Array): string {
  return bytesToHex(schnorr.sign(hexToBytes(messageHashHex), secretKey));
}

export function verifyHash(signatureHex: string, messageHashHex: string, pubkey: string): boolean {
  try {
    return schnorr.verify(hexToBytes(signatureHex), hexToBytes(messageHashHex), hexToBytes(toPubkeyHex(pubkey)));
  } catch {
    return false;
  }
}

/**
 * Verify a Nostr event's id and signature from scratch. Unlike nostr-tools' `verifyEvent`, this never trusts a cached
 * "verified" marker on the object, which survives `{ ...event }` copies and would let an edited copy pass.
 */
export function verifyEventStrict(e: Event): boolean {
  try {
    if (typeof e?.id !== "string" || typeof e.sig !== "string" || typeof e.pubkey !== "string") return false;
    if (!/^[0-9a-f]{64}$/.test(e.id) || !/^[0-9a-f]{128}$/.test(e.sig) || !/^[0-9a-f]{64}$/.test(e.pubkey))
      return false;
    if (!Number.isInteger(e.kind) || !Number.isInteger(e.created_at) || typeof e.content !== "string") return false;
    if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string")))
      return false;
    if (getEventHash(e) !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}
