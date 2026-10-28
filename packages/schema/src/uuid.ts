import { bytesToHex } from "@noble/hashes/utils.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A UUID version 7 (time-ordered), used as the stable story id. */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isUuidv7(s: unknown): s is string {
  return typeof s === "string" && UUID.test(s);
}

/** The story id as a 0x-prefixed bytes16 value for the registry contract. */
export function storyIdToBytes16(id: string): `0x${string}` {
  if (!isUuidv7(id)) throw new Error(`not a UUIDv7: ${id}`);
  return `0x${id.replace(/-/g, "")}`;
}

export function bytes16ToStoryId(hex: string): string {
  const h = hex.replace(/^0x/, "").toLowerCase();
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  if (!isUuidv7(id)) throw new Error(`not a UUIDv7 bytes16: ${hex}`);
  return id;
}
