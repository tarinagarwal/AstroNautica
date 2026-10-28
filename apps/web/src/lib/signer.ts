/**
 * A signing identity: either a secret key held in memory, or a NIP-07 browser extension (`window.nostr`). NIP-07
 * can sign and (in most extensions) do NIP-44, but cannot do X25519; contributors don't need X25519 because they
 * only wrap content keys with public keys (spec §8.3).
 */
import { createAuthHeader, KIND_HTTP_AUTH } from "@core/auth.js";
import { keyPairFromSecret } from "@core/keys.js";
import { sha256Hex } from "@azaadawaaz/schema";
import { finalizeEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

export interface Signer {
  kind: "local" | "nip07";
  pubkey: string;
  npub: string;
  /** Only for local keys. */
  secretKey?: Uint8Array;
  sign(t: EventTemplate): Promise<Event>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  authHeader(url: string, method: string, body?: Uint8Array | string): Promise<string>;
}

export function localSigner(secretKey: Uint8Array): Signer {
  const kp = keyPairFromSecret(secretKey);
  return {
    kind: "local",
    pubkey: kp.pubkey,
    npub: kp.npub,
    secretKey,
    sign: async (t) => finalizeEvent(t, secretKey),
    nip44Encrypt: async (peer, text) => nip44.encrypt(text, nip44.getConversationKey(secretKey, peer)),
    nip44Decrypt: async (peer, ct) => nip44.decrypt(ct, nip44.getConversationKey(secretKey, peer)),
    authHeader: async (url, method, body) => createAuthHeader(url, method, secretKey, body),
  };
}

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<Event>;
  nip44?: { encrypt(peer: string, text: string): Promise<string>; decrypt(peer: string, ct: string): Promise<string> };
}

export function nip07Available(): boolean {
  return typeof window !== "undefined" && typeof (window as { nostr?: Nip07 }).nostr?.signEvent === "function";
}

export async function nip07Signer(): Promise<Signer> {
  const ext = (window as unknown as { nostr?: Nip07 }).nostr;
  if (!ext) throw new Error("no NIP-07 extension");
  const pubkey = await ext.getPublicKey();
  const { npubEncode } = await import("nostr-tools/nip19");
  const needNip44 = () => {
    if (!ext.nip44) throw new Error("nip44-unsupported");
    return ext.nip44;
  };
  return {
    kind: "nip07",
    pubkey,
    npub: npubEncode(pubkey),
    sign: (t) => ext.signEvent(t),
    nip44Encrypt: (peer, text) => needNip44().encrypt(peer, text),
    nip44Decrypt: (peer, ct) => needNip44().decrypt(peer, ct),
    authHeader: async (url, method, body) => {
      // Same event shape as core `createAuthHeader` (NIP-98).
      const tags = [
        ["u", url],
        ["method", method.toUpperCase()],
      ];
      if (body !== undefined && body.length > 0) tags.push(["payload", sha256Hex(body)]);
      const e = await ext.signEvent({
        kind: KIND_HTTP_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: "",
      });
      return `Nostr ${btoa(JSON.stringify(e))}`;
    },
  };
}
