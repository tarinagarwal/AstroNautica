#!/usr/bin/env node
/**
 * Generate a new set of publisher service keys (runbook: docs/runbooks/key-rotation.md):
 * Nostr (signs story events), X25519 (receives content keys on approval), EVM (writes chain receipts).
 *
 *   node scripts/gen-service-keys.mjs --public publisher-public.json > publisher-keys.json
 *
 * stdout contains secrets: store it in the publisher's secrets store, never in the repository. The `--public` file has
 * only the public keys; that is the file to carry to the offline owner machine for
 * `owner-sign-list.mjs service-keys --rotate-publisher publisher-public.json` (no secrets on the owner machine).
 */
import { generateEncryptionKeyPair, generateKeyPair } from "@azaadawaaz/core";
import { writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseArgs } from "./lib/common.mjs";

const n = generateKeyPair();
const x = await generateEncryptionKeyPair();
const evmKey = generatePrivateKey();
const out = {
  role: "publisher",
  createdAt: new Date().toISOString(),
  nostr: { pubkey: n.pubkey, npub: n.npub, nsec: n.nsec },
  x25519: { publicKey: x.publicKey, privateKey: x.privateKey },
  evm: { address: privateKeyToAccount(evmKey).address, privateKey: evmKey },
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
const args = parseArgs();
if (args.public) {
  const pub = {
    role: "publisher",
    createdAt: out.createdAt,
    nostr: { pubkey: n.pubkey, npub: n.npub },
    x25519: { publicKey: x.publicKey },
    evm: { address: out.evm.address },
  };
  writeFileSync(args.public, JSON.stringify(pub, null, 2) + "\n");
}
