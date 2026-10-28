import { mineAndSign } from "@core/social.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Event, EventTemplate } from "nostr-tools/pure";

/** Mine NIP-13 PoW and sign in a Web Worker; falls back to the main thread where workers are unavailable. */
export function mineInWorker(template: EventTemplate, secretKey: Uint8Array, difficulty: number): Promise<Event> {
  if (typeof Worker === "undefined") return mineAndSign(template, secretKey, difficulty);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../workers/pow.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (m: MessageEvent<{ ok: boolean; event?: Event; error?: string }>) => {
      w.terminate();
      if (m.data.ok && m.data.event) resolve(m.data.event);
      else reject(new Error(m.data.error ?? "proof-of-work failed"));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "worker failed"));
    };
    w.postMessage({ template, secretKeyHex: bytesToHex(secretKey), difficulty });
  });
}
