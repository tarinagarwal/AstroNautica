#!/usr/bin/env node
// Test vectors made with packages/core's staging crypto (libsodium-wrappers), for the Kotlin byte-compatibility tests
// (android/jvm-tests SodiumOpsTest): X25519 key derivation, sealed boxes, secretstream chunks and encryptJson output.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../package.json"));
const core = await import(require.resolve("@azaadawaaz/core"));
const sodium = await core.sodiumReady();
const hex = (b) => Buffer.from(b).toString("hex");

const kp = await core.generateEncryptionKeyPair();
const contentKey = await core.newContentKey();
const message = new TextEncoder().encode("नमस्ते AzaadAwaaz — staging vector");
const plain = new Uint8Array(2500).map((_, i) => (i * 7 + 3) & 255);
const blob = await core.encryptBytes(plain, contentKey, 1000);
const empty = await core.encryptBytes(new Uint8Array(0), contentKey);
const sealedJson = await core.encryptJson({ hello: "world", n: 1 }, contentKey);

const vectors = {
  x25519: { privateKey: kp.privateKey, publicKey: kp.publicKey },
  sealedBox: {
    recipientPublic: kp.publicKey,
    recipientPrivate: kp.privateKey,
    message: hex(contentKey),
    sealed: hex(sodium.crypto_box_seal(contentKey, sodium.from_hex(kp.publicKey))),
  },
  wrapKey: { wrapped: await core.wrapKey(contentKey, kp.publicKey), contentKey: hex(contentKey) },
  secretstream: {
    key: hex(contentKey),
    header: hex(blob.header),
    chunks: blob.chunks.map(hex),
    chunkSize: 1000,
    plaintext: hex(plain),
  },
  emptyStream: { key: hex(contentKey), header: hex(empty.header), chunks: empty.chunks.map(hex) },
  encryptJson: { key: hex(contentKey), sealed: sealedJson, json: '{"hello":"world","n":1}' },
  message: hex(message),
};
const out = resolve(here, "../android/jvm-tests/src/test/resources/sodium-vectors.json");
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`gen-sodium-vectors: wrote ${out}`);
