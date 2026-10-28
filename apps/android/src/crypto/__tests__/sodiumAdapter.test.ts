/**
 * The libsodium-wrappers adapter that replaces WASM libsodium on Hermes. Here its backend is real libsodium (the same
 * operations the Kotlin module performs), and packages/core's own staging code is loaded on top of the adapter, then
 * checked against core running on libsodium-wrappers directly: byte formats must interoperate both ways.
 */
import realSodium from "libsodium-wrappers";
import * as core from "@azaadawaaz/core";
import { createSodiumAdapter, type SodiumBackend } from "../sodiumAdapter";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** A backend with the native module's contract, implemented with libsodium-wrappers (as SodiumOps does with lazysodium). */
function libsodiumBackend(): SodiumBackend & { live: () => number } {
  const s = realSodium;
  const states = new Map<number, unknown>();
  let next = 1;
  return {
    live: () => states.size,
    randomBytes: (n) => b64(s.randombytes_buf(n)),
    boxKeypair: () => {
      const kp = s.crypto_box_keypair();
      return JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) });
    },
    scalarmultBase: (sk) => b64(s.crypto_scalarmult_base(unb64(sk))),
    boxSeal: (m, pk) => b64(s.crypto_box_seal(unb64(m), unb64(pk))),
    boxSealOpen: (c, pk, sk) => {
      try {
        return b64(s.crypto_box_seal_open(unb64(c), unb64(pk), unb64(sk)));
      } catch {
        return null;
      }
    },
    secretstreamKeygen: () => b64(s.crypto_secretstream_xchacha20poly1305_keygen()),
    secretstreamInitPush: (k) => {
      const r = s.crypto_secretstream_xchacha20poly1305_init_push(unb64(k));
      const id = next++;
      states.set(id, r.state);
      return JSON.stringify({ state: id, header: b64(r.header) });
    },
    secretstreamPush: (id, m, tag) => {
      const out = s.crypto_secretstream_xchacha20poly1305_push(states.get(id) as never, unb64(m), null, tag);
      if (tag === 3) states.delete(id);
      return b64(out);
    },
    secretstreamInitPull: (h, k) => {
      try {
        const st = s.crypto_secretstream_xchacha20poly1305_init_pull(unb64(h), unb64(k));
        const id = next++;
        states.set(id, st);
        return id;
      } catch {
        return -1;
      }
    },
    secretstreamPull: (id, c) => {
      const r = s.crypto_secretstream_xchacha20poly1305_pull(states.get(id) as never, unb64(c), null);
      if (!r) return null;
      if (r.tag === 3) states.delete(id);
      return JSON.stringify({ message: b64(r.message), tag: r.tag });
    },
    secretstreamFree: (id) => void states.delete(id),
  };
}

let backend: ReturnType<typeof libsodiumBackend>;
let adapted: typeof core;

beforeAll(async () => {
  await realSodium.ready;
  backend = libsodiumBackend();
  const adapter = createSodiumAdapter(backend);
  jest.isolateModules(() => {
    jest.doMock("libsodium-wrappers", () => ({ __esModule: true, default: adapter }));
    adapted = require("@azaadawaaz/core");
  });
});

describe("libsodium-wrappers adapter under packages/core staging", () => {
  it("is really a different core instance (the adapter is in use)", () => {
    expect(adapted).not.toBe(core);
  });

  it("derives X25519 public keys and wraps keys interoperably", async () => {
    const kp = await core.generateEncryptionKeyPair();
    expect(await adapted.encryptionPublicKey(kp.privateKey)).toBe(kp.publicKey);
    const kp2 = await adapted.generateEncryptionKeyPair();
    expect(await core.encryptionPublicKey(kp2.privateKey)).toBe(kp2.publicKey);
    const key = await core.newContentKey();
    expect(await core.unwrapKey(await adapted.wrapKey(key, kp.publicKey), kp)).toEqual(key);
    expect(await adapted.unwrapKey(await core.wrapKey(key, kp.publicKey), kp)).toEqual(key);
    await expect(adapted.unwrapKey(await core.wrapKey(key, kp.publicKey), kp2)).rejects.toThrow();
  });

  it("encrypts chunked media and JSON interoperably both ways", async () => {
    const key = await adapted.newContentKey();
    const data = Uint8Array.from({ length: 2_600_000 }, (_, i) => (i * 7) & 255);
    const blob = await adapted.encryptBytes(data, key);
    expect(blob.chunks).toHaveLength(3);
    expect(blob.chunks[0]!.length).toBe(core.CHUNK_SIZE + core.ABYTES);
    expect(await core.decryptBytes(blob, key)).toEqual(data);
    const blob2 = await core.encryptBytes(data, key);
    expect(await adapted.decryptBytes(blob2, key)).toEqual(data);
    const sealed = await adapted.encryptJson({ title: "घाटी" }, key);
    expect(await core.decryptJson(sealed, key)).toEqual({ title: "घाटी" });
    expect(await adapted.decryptJson(await core.encryptJson({ a: 1 }, key), key)).toEqual({ a: 1 });
    expect(await adapted.decryptBytes(await core.encryptBytes(new Uint8Array(0), key), key)).toEqual(new Uint8Array(0));
  });

  it("detects tampering, truncation and reordering like core", async () => {
    const key = await adapted.newContentKey();
    const blob = await core.encryptBytes(Uint8Array.from({ length: 3000 }, (_, i) => i & 255), key, 1000);
    const bad = { header: blob.header, chunks: blob.chunks.map((c, i) => (i === 1 ? Uint8Array.from(c, (x, j) => (j === 3 ? x ^ 1 : x)) : c)) };
    await expect(adapted.decryptBytes(bad, key)).rejects.toThrow();
    await expect(adapted.decryptBytes({ header: blob.header, chunks: blob.chunks.slice(0, 2) }, key)).rejects.toThrow(/truncated/);
    await expect(adapted.decryptBytes({ header: blob.header, chunks: [blob.chunks[1]!, blob.chunks[0]!, blob.chunks[2]!] }, key)).rejects.toThrow();
  });

  it("does not leave stream states behind after complete streams", async () => {
    const before = backend.live();
    const key = await adapted.newContentKey();
    await adapted.decryptBytes(await adapted.encryptBytes(new Uint8Array(5000), key, 1000), key);
    expect(backend.live()).toBe(before);
  });

  it("refuses additional data and malformed input instead of misbehaving", () => {
    const a = createSodiumAdapter(backend);
    const { state } = a.crypto_secretstream_xchacha20poly1305_init_push(new Uint8Array(32));
    expect(() => a.crypto_secretstream_xchacha20poly1305_push(state, new Uint8Array(1), new Uint8Array(1), 0)).toThrow();
    expect(() => a.from_hex("zz")).toThrow();
    expect(a.to_base64(Uint8Array.from([251, 255]), a.base64_variants.URLSAFE_NO_PADDING)).toBe("-_8");
    expect(a.from_base64("-_8")).toEqual(Uint8Array.from([251, 255]));
    expect(() => a.crypto_secretstream_xchacha20poly1305_init_pull(new Uint8Array(3), new Uint8Array(32))).toThrow();
  });
});
