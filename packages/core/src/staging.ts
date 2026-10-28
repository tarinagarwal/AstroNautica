/**
 * Staging encryption (spec §5.2, decisions D1 and D2).
 *
 * Each submission has a random content key. Its text and media are encrypted with libsodium secretstream
 * (XChaCha20-Poly1305) in 1 MiB chunks. The content key is wrapped with a sealed box for each moderator's and the
 * owner's X25519 key; on approval the moderator re-wraps it for the publisher.
 */
import sodium from "libsodium-wrappers";

export const CHUNK_SIZE = 1024 * 1024;

export async function sodiumReady(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

export interface EncryptionKeyPair {
  publicKey: string; // hex
  privateKey: string; // hex
}

const hex = (b: Uint8Array) => sodium.to_hex(b);
const unhex = (s: string) => sodium.from_hex(s);
const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

export async function generateEncryptionKeyPair(): Promise<EncryptionKeyPair> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { publicKey: hex(kp.publicKey), privateKey: hex(kp.privateKey) };
}

/** Derive the X25519 public key from a private key (hex). */
export async function encryptionPublicKey(privateKeyHex: string): Promise<string> {
  await sodium.ready;
  return hex(sodium.crypto_scalarmult_base(unhex(privateKeyHex)));
}

export async function newContentKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_secretstream_xchacha20poly1305_keygen();
}

/** Wrap a content key for one recipient's X25519 public key (sealed box, base64url). */
export async function wrapKey(contentKey: Uint8Array, recipientPublicKeyHex: string): Promise<string> {
  await sodium.ready;
  return b64(sodium.crypto_box_seal(contentKey, unhex(recipientPublicKeyHex)));
}

export async function unwrapKey(wrapped: string, keyPair: EncryptionKeyPair): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_box_seal_open(unb64(wrapped), unhex(keyPair.publicKey), unhex(keyPair.privateKey));
}

/** Wrap for many recipients at once: X25519 public key (hex) → wrapped key. */
export async function wrapKeyFor(contentKey: Uint8Array, recipients: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of new Set(recipients)) out[r] = await wrapKey(contentKey, r);
  return out;
}

export class Encryptor {
  readonly header: Uint8Array;
  private readonly state: sodium.StateAddress;
  private finished = false;

  constructor(key: Uint8Array) {
    const r = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
    this.state = r.state;
    this.header = r.header;
  }

  /** Encrypt one chunk. The last chunk must be pushed with `final = true` so truncation is detected. */
  push(chunk: Uint8Array, final: boolean): Uint8Array {
    if (this.finished) throw new Error("stream already finished");
    if (final) this.finished = true;
    const tag = final
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    return sodium.crypto_secretstream_xchacha20poly1305_push(this.state, chunk, null, tag);
  }
}

export class Decryptor {
  private readonly state: sodium.StateAddress;
  private finished = false;

  constructor(key: Uint8Array, header: Uint8Array) {
    this.state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  }

  get done(): boolean {
    return this.finished;
  }

  /** Decrypt one chunk; throws if it was tampered with, reordered, or comes after the final chunk. */
  pull(cipher: Uint8Array): { data: Uint8Array; final: boolean } {
    if (this.finished) throw new Error("data after the final chunk");
    const r = sodium.crypto_secretstream_xchacha20poly1305_pull(this.state, cipher, null);
    if (!r) throw new Error("chunk failed authentication");
    const final = r.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    if (final) this.finished = true;
    return { data: r.message, final };
  }
}

export const ABYTES = 17; // crypto_secretstream_xchacha20poly1305_ABYTES

export interface EncryptedBlob {
  header: Uint8Array;
  chunks: Uint8Array[];
}

/** Encrypt a whole buffer into 1 MiB chunks. For large files use `Encryptor` directly while streaming. */
export async function encryptBytes(data: Uint8Array, key: Uint8Array, chunkSize = CHUNK_SIZE): Promise<EncryptedBlob> {
  await sodium.ready;
  const enc = new Encryptor(key);
  const chunks: Uint8Array[] = [];
  if (data.length === 0) chunks.push(enc.push(new Uint8Array(0), true));
  for (let off = 0; off < data.length; off += chunkSize) {
    const end = Math.min(off + chunkSize, data.length);
    chunks.push(enc.push(data.subarray(off, end), end === data.length));
  }
  return { header: enc.header, chunks };
}

export async function decryptBytes(blob: EncryptedBlob, key: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  const dec = new Decryptor(key, blob.header);
  const parts: Uint8Array[] = [];
  for (const c of blob.chunks) parts.push(dec.pull(c).data);
  if (!dec.done) throw new Error("stream truncated: final chunk missing");
  return concat(parts);
}

/** Encrypt a JSON value as a single-chunk stream; returns base64url `header.cipher`. */
export async function encryptJson(value: unknown, key: Uint8Array): Promise<string> {
  const blob = await encryptBytes(new TextEncoder().encode(JSON.stringify(value)), key, Number.MAX_SAFE_INTEGER);
  return `${b64(blob.header)}.${b64(blob.chunks[0]!)}`;
}

export async function decryptJson<T = unknown>(sealed: string, key: Uint8Array): Promise<T> {
  await sodium.ready;
  const [h, c] = sealed.split(".");
  if (!h || !c) throw new Error("malformed sealed JSON");
  const bytes = await decryptBytes({ header: unb64(h), chunks: [unb64(c)] }, key);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export { b64 as toBase64Url, unb64 as fromBase64Url };
