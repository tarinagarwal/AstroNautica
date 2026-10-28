/**
 * A libsodium-wrappers-compatible object backed by a synchronous native libsodium (lazysodium on Android).
 *
 * Why: libsodium-wrappers 0.7.x ships only a WebAssembly build and Hermes has no WebAssembly, so packages/core's
 * staging code (sealed boxes, secretstream) would fail on the phone. Metro maps `libsodium-wrappers` to this adapter
 * (metro.config.js), so core's own `staging.ts` runs unchanged on top of real libsodium. Only the functions core uses
 * are provided; anything else throws instead of silently misbehaving.
 */
import { base64ToBytes, bytesToBase64, fromUtf8, utf8 } from "../util/bytes";

/** The synchronous native surface (NativeAzaadSodium). Bytes cross as standard base64. */
export interface SodiumBackend {
  randomBytes(length: number): string;
  boxKeypair(): string;
  scalarmultBase(privateKeyB64: string): string;
  boxSeal(messageB64: string, publicKeyB64: string): string;
  boxSealOpen(cipherB64: string, publicKeyB64: string, privateKeyB64: string): string | null;
  secretstreamKeygen(): string;
  secretstreamInitPush(keyB64: string): string;
  secretstreamPush(state: number, messageB64: string, tag: number): string;
  secretstreamInitPull(headerB64: string, keyB64: string): number;
  secretstreamPull(state: number, cipherB64: string): string | null;
  secretstreamFree(state: number): void;
}

export const base64_variants = { ORIGINAL: 1, ORIGINAL_NO_PADDING: 3, URLSAFE: 5, URLSAFE_NO_PADDING: 7 } as const;
type Variant = (typeof base64_variants)[keyof typeof base64_variants];

const HEX = "0123456789abcdef";
const asBytes = (x: Uint8Array | string) => (typeof x === "string" ? utf8(x) : x);
const b64 = (x: Uint8Array | string) => bytesToBase64(asBytes(x));

function noAd(ad: unknown): void {
  if (ad !== null && ad !== undefined) throw new Error("additional data is not supported by this adapter");
}

export function createSodiumAdapter(backend: SodiumBackend) {
  const TAG_MESSAGE = 0;
  const TAG_FINAL = 3;
  return {
    ready: Promise.resolve(),
    base64_variants,

    to_hex(input: Uint8Array | string): string {
      const b = asBytes(input);
      let s = "";
      for (let i = 0; i < b.length; i++) s += HEX[b[i]! >> 4]! + HEX[b[i]! & 15]!;
      return s;
    },
    from_hex(hex: string): Uint8Array {
      if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error("invalid input");
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    },
    to_base64(input: Uint8Array | string, variant: Variant = base64_variants.URLSAFE_NO_PADDING): string {
      const url = variant === base64_variants.URLSAFE || variant === base64_variants.URLSAFE_NO_PADDING;
      const pad = variant === base64_variants.ORIGINAL || variant === base64_variants.URLSAFE;
      let s = bytesToBase64(asBytes(input), url);
      if (url && pad) while (s.length % 4) s += "=";
      if (!pad) s = s.replace(/=+$/, "");
      return s;
    },
    from_base64(input: string, variant: Variant = base64_variants.URLSAFE_NO_PADDING): Uint8Array {
      const url = variant === base64_variants.URLSAFE || variant === base64_variants.URLSAFE_NO_PADDING;
      if (url ? /[+/]/.test(input) : /[-_]/.test(input)) throw new Error("incomplete input");
      return base64ToBytes(input);
    },
    to_string: (b: Uint8Array) => fromUtf8(b),
    from_string: (s: string) => utf8(s),
    randombytes_buf: (n: number) => base64ToBytes(backend.randomBytes(n)),

    crypto_box_keypair() {
      const kp = JSON.parse(backend.boxKeypair()) as { publicKey: string; privateKey: string };
      return { publicKey: base64ToBytes(kp.publicKey), privateKey: base64ToBytes(kp.privateKey), keyType: "x25519" as const };
    },
    crypto_scalarmult_base(privateKey: Uint8Array): Uint8Array {
      if (privateKey.length !== 32) throw new Error("invalid privateKey length");
      return base64ToBytes(backend.scalarmultBase(b64(privateKey)));
    },
    crypto_box_seal(message: Uint8Array | string, publicKey: Uint8Array): Uint8Array {
      if (publicKey.length !== 32) throw new Error("invalid publicKey length");
      return base64ToBytes(backend.boxSeal(b64(message), b64(publicKey)));
    },
    crypto_box_seal_open(cipher: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array {
      const r = backend.boxSealOpen(b64(cipher), b64(publicKey), b64(privateKey));
      if (r === null) throw new Error("incorrect key pair for the given ciphertext");
      return base64ToBytes(r);
    },

    crypto_secretstream_xchacha20poly1305_ABYTES: 17,
    crypto_secretstream_xchacha20poly1305_HEADERBYTES: 24,
    crypto_secretstream_xchacha20poly1305_KEYBYTES: 32,
    crypto_secretstream_xchacha20poly1305_TAG_MESSAGE: TAG_MESSAGE,
    crypto_secretstream_xchacha20poly1305_TAG_PUSH: 1,
    crypto_secretstream_xchacha20poly1305_TAG_REKEY: 2,
    crypto_secretstream_xchacha20poly1305_TAG_FINAL: TAG_FINAL,
    crypto_secretstream_xchacha20poly1305_keygen: () => base64ToBytes(backend.secretstreamKeygen()),
    crypto_secretstream_xchacha20poly1305_init_push(key: Uint8Array): { state: number; header: Uint8Array } {
      if (key.length !== 32) throw new Error("invalid key length");
      const r = JSON.parse(backend.secretstreamInitPush(b64(key))) as { state: number; header: string };
      return { state: r.state, header: base64ToBytes(r.header) };
    },
    crypto_secretstream_xchacha20poly1305_push(
      state: number,
      message: Uint8Array | string,
      ad: Uint8Array | null,
      tag: number,
    ): Uint8Array {
      noAd(ad);
      return base64ToBytes(backend.secretstreamPush(state, b64(message), tag));
    },
    crypto_secretstream_xchacha20poly1305_init_pull(header: Uint8Array, key: Uint8Array): number {
      if (header.length !== 24 || key.length !== 32) throw new Error("invalid usage");
      const state = backend.secretstreamInitPull(b64(header), b64(key));
      if (state < 0) throw new Error("invalid usage");
      return state;
    },
    crypto_secretstream_xchacha20poly1305_pull(
      state: number,
      cipher: Uint8Array,
      ad: Uint8Array | null,
    ): { message: Uint8Array; tag: number } | false {
      noAd(ad);
      if (cipher.length < 17) throw new Error("ciphertext is too short");
      const r = backend.secretstreamPull(state, b64(cipher));
      if (r === null) return false;
      const p = JSON.parse(r) as { message: string; tag: number };
      return { message: base64ToBytes(p.message), tag: p.tag };
    },
    /** Release a stream state early (native also frees after the final chunk and caps live states). */
    crypto_secretstream_xchacha20poly1305_free: (state: number) => backend.secretstreamFree(state),
  };
}

export type SodiumAdapter = ReturnType<typeof createSodiumAdapter>;
