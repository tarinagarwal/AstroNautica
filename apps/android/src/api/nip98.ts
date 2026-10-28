import { KIND_HTTP_AUTH, createAuthHeader } from "@azaadawaaz/core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { bytesToBase64, utf8 } from "../util/bytes";

/**
 * NIP-98 `Authorization: Nostr <base64 event>` for a body whose SHA-256 is already known (chunk files encrypted and
 * hashed natively, never loaded into JS). Same event shape as core `createAuthHeader`, which is used for in-memory
 * bodies; tests check both against core `verifyAuthHeader`.
 */
export function createAuthHeaderForHash(
  url: string,
  method: string,
  secretKey: Uint8Array,
  payloadSha256: string | undefined,
  createdAt = Math.floor(Date.now() / 1000),
): string {
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (payloadSha256) tags.push(["payload", payloadSha256]);
  const e = finalizeEvent({ kind: KIND_HTTP_AUTH, created_at: createdAt, tags, content: "" }, secretKey);
  return `Nostr ${bytesToBase64(utf8(JSON.stringify(e)))}`;
}

export interface Signer {
  pubkey: string;
  authHeader(url: string, method: string, body?: Uint8Array | string): string;
  authHeaderForHash(url: string, method: string, payloadSha256?: string): string;
}

export function signerFromSecret(secretKey: Uint8Array): Signer {
  return {
    pubkey: getPublicKey(secretKey),
    authHeader: (url, method, body) => createAuthHeader(url, method, secretKey, body),
    authHeaderForHash: (url, method, hash) => createAuthHeaderForHash(url, method, secretKey, hash),
  };
}
