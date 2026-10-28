#!/usr/bin/env node
/**
 * Generate the owner key on an offline machine (runbook: docs/runbooks/owner-key-ceremony.md).
 *
 *   node scripts/gen-owner-key.mjs --out owner.key.enc [--x25519]
 *
 * Writes the Nostr secret (and optionally an X25519 key pair) encrypted with a passphrase (Argon2id + XSalsa20-Poly1305),
 * and prints the npub and, once, the nsec for the paper backup.
 */
import { existsSync, writeFileSync } from "node:fs";
import { generateEncryptionKeyPair, generateKeyPair } from "@azaadawaaz/core";
import sodium from "libsodium-wrappers-sumo";
import { askPassphrase, encryptSecret, parseArgs } from "./lib/common.mjs";

const args = parseArgs();
const out = args.out ?? "owner.key.enc";
if (existsSync(out) && !args.force) {
  console.error(`${out} exists; refusing to overwrite (use --force).`);
  process.exit(1);
}
const pass = await askPassphrase("New passphrase (at least 12 characters): ");
if (pass.length < 12) {
  console.error("Passphrase too short.");
  process.exit(1);
}
if (!process.env.OWNER_PASSPHRASE && (await askPassphrase("Repeat passphrase: ")) !== pass) {
  console.error("Passphrases differ.");
  process.exit(1);
}
await sodium.ready;
const k = generateKeyPair();
const file = { npub: k.npub, pubkey: k.pubkey, nostr: await encryptSecret(k.secretKey, pass) };
let x;
if (args.x25519) {
  x = await generateEncryptionKeyPair();
  file.x25519 = x.publicKey;
  file.x25519Private = await encryptSecret(sodium.from_hex(x.privateKey), pass);
}
writeFileSync(out, JSON.stringify(file, null, 2), { mode: 0o600 });
console.log(`Owner npub:   ${k.npub}`);
console.log(`Owner pubkey: ${k.pubkey}`);
if (x) console.log(`Owner X25519 public key: ${x.publicKey}`);
console.log(`\nWrite this down on paper (shown once):\n  ${k.nsec}`);
if (x) console.log(`  X25519 private key: ${x.privateKey}`);
console.log(`\nEncrypted key file: ${out}`);
