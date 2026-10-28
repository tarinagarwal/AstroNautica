/**
 * The reverse byte-compatibility check: android/jvm-tests (SodiumOpsTest, running the app's Kotlin SodiumOps on
 * libsodium via lazysodium) writes build/vectors/kotlin-vectors.json; packages/core must open everything in it.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as core from "@azaadawaaz/core";

const file = resolve(__dirname, "../../../android/jvm-tests/build/vectors/kotlin-vectors.json");
const have = existsSync(file);
const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

(have ? describe : describe.skip)("Kotlin SodiumOps output opened by packages/core", () => {
  const v = have ? JSON.parse(readFileSync(file, "utf8")) : {};

  it("unwraps the Kotlin sealed box and decrypts the Kotlin secretstream", async () => {
    const key = await core.unwrapKey(v.wrapped, v.x25519);
    expect(Buffer.from(key).toString("hex")).toBe(v.contentKey);
    expect(await core.encryptionPublicKey(v.x25519.privateKey)).toBe(v.x25519.publicKey);
    const plain = await core.decryptBytes({ header: hex(v.stream.header), chunks: v.stream.chunks.map(hex) }, key);
    expect(Buffer.from(plain).toString("hex")).toBe(v.stream.plaintext);
  });
});

if (!have) console.warn(`kotlinVectors: ${file} not found; run the JVM tests (android/jvm-tests) first`);
