/**
 * Keys at rest in the browser are encrypted with a passphrase: PBKDF2-SHA256 (600k iterations) → AES-256-GCM via
 * WebCrypto, stored in IndexedDB (spec §3: moderator keys "encrypted with a passphrase in IndexedDB").
 */
import { idbDel, idbGet, idbSet } from "./idb.js";

export interface Sealed {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
  iterations: number;
}

const ITERATIONS = 600_000;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(data: unknown, passphrase: string, iterations = ITERATIONS): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))),
  );
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), iterations };
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("wrong passphrase");
    this.name = "WrongPassphraseError";
  }
}

export async function unseal<T>(s: Sealed, passphrase: string): Promise<T> {
  const key = await deriveKey(passphrase, unb64(s.salt), s.iterations);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(s.iv) as BufferSource },
      key,
      unb64(s.ct) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    throw new WrongPassphraseError();
  }
}

export type VaultName = "contributor" | "moderator";

export interface VaultRecord {
  pubkey: string;
  sealed: Sealed;
}

export async function saveVault(
  name: VaultName,
  pubkey: string,
  secrets: unknown,
  passphrase: string,
  iterations?: number,
) {
  await idbSet(`vault:${name}`, { pubkey, sealed: await seal(secrets, passphrase, iterations) } satisfies VaultRecord);
}

export function loadVault(name: VaultName): Promise<VaultRecord | undefined> {
  return idbGet<VaultRecord>(`vault:${name}`);
}

export function clearVault(name: VaultName): Promise<void> {
  return idbDel(`vault:${name}`);
}
