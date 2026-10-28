#!/usr/bin/env node
/**
 * Generate a new set of publisher service keys (runbook: docs/runbooks/key-rotation.md):
 * Nostr (signs story events), X25519 (receives content keys on approval), EVM (writes chain receipts).
 *
 *   node scripts/gen-service-keys.mjs > publisher-keys.json
 *
 * The output contains secrets: store it in the publisher's secrets store, never in the repository.
 */
import { generateEncryptionKeyPair, generateKeyPair } from "@azaadawaaz/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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
