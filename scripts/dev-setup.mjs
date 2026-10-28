#!/usr/bin/env node
/**
 * Local development setup. Creates SAMPLE keys (never use them in production), deploys the registry to both local
 * chains, signs and publishes the official owner lists to the local relays, and writes `.dev/config.json`,
 * `.dev/keys.json` and `.dev/list-events.json`.
 *
 * Prerequisite: the dev network is running (`docker compose -f infra/dev/docker-compose.yml up -d`).
 * Usage: node scripts/dev-setup.mjs [--reset]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createListEvent,
  generateEncryptionKeyPair,
  generateKeyPair,
  keyPairFromSecret,
  parseSecretKey,
  RelayPool,
} from "@azaadawaaz/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devDir = join(root, ".dev");
const reset = process.argv.includes("--reset");
mkdirSync(devDir, { recursive: true });

const RELAYS = ["ws://127.0.0.1:7777", "ws://127.0.0.1:7778"];
const IPFS_APIS = ["http://127.0.0.1:5001", "http://127.0.0.1:5002"];
const IPFS_GATEWAYS = ["http://127.0.0.1:8080", "http://127.0.0.1:8081"];
const ARWEAVE = "http://127.0.0.1:1984";
// Anvil's well-known development accounts (public test keys, funded on every anvil chain).
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];
const CHAINS = [
  { key: "base-local", chainId: 31337, rpc: "http://127.0.0.1:8545" },
  { key: "bsc-local", chainId: 97, rpc: "http://127.0.0.1:8546" },
];

const log = (...a) => console.log("[dev-setup]", ...a);

// ---------- keys ----------
const keysPath = join(devDir, "keys.json");
let keys;
if (existsSync(keysPath) && !reset) {
  keys = JSON.parse(readFileSync(keysPath, "utf8"));
  log("using existing sample keys", keysPath);
} else {
  const nostr = (k) => ({ pubkey: k.pubkey, npub: k.npub, nsec: k.nsec });
  const x = async () => {
    const kp = await generateEncryptionKeyPair();
    return { x25519: kp.publicKey, x25519Private: kp.privateKey };
  };
  // Anvil account #0 owns the contract; #1 is the publisher's EVM key.
  keys = {
    WARNING: "SAMPLE KEYS FOR LOCAL DEVELOPMENT ONLY. Never use them for anything real.",
    owner: { ...nostr(generateKeyPair()), ...(await x()), evmPrivateKey: ANVIL_KEYS[0] },
    publisher: { ...nostr(generateKeyPair()), ...(await x()), evmPrivateKey: ANVIL_KEYS[1] },
    moderators: [
      { name: "Sample Moderator A", ...nostr(generateKeyPair()), ...(await x()) },
      { name: "Sample Moderator B", ...nostr(generateKeyPair()), ...(await x()) },
    ],
  };
  writeFileSync(keysPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
  log("created sample keys", keysPath);
}

// ---------- contracts ----------
const contractsDir = join(root, "packages/contracts");
const artifactPath = join(contractsDir, "out/AzaadAwaazRegistry.sol/AzaadAwaazRegistry.json");
if (!existsSync(artifactPath)) {
  log("building contracts (forge build with the bundled solcjs wrapper)");
  execFileSync("forge", ["build"], {
    cwd: contractsDir,
    stdio: "inherit",
    env: { ...process.env, FOUNDRY_SOLC: join(contractsDir, "scripts/solcjs"), FOUNDRY_OFFLINE: "true" },
  });
}
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const ownerEvm = privateKeyToAccount(keys.owner.evmPrivateKey);
const publisherEvm = privateKeyToAccount(keys.publisher.evmPrivateKey);
const deploymentsPath = join(devDir, "deployments.json");
const deployments = existsSync(deploymentsPath) && !reset ? JSON.parse(readFileSync(deploymentsPath, "utf8")) : {};
const chains = [];
for (const c of CHAINS) {
  const chain = defineChain({
    id: c.chainId,
    name: c.key,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(c.rpc) });
  const prev = deployments[c.key];
  if (prev && (await pub.getCode({ address: prev }).catch(() => undefined))) {
    chains.push({ ...c, registry: prev });
    log(`registry already deployed on ${c.key} at ${prev}`);
    continue;
  }
  const wallet = createWalletClient({ chain, transport: http(c.rpc), account: ownerEvm });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [ownerEvm.address, publisherEvm.address],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  deployments[c.key] = r.contractAddress;
  chains.push({ ...c, registry: r.contractAddress });
  log(`deployed registry on ${c.key} (chain ${c.chainId}) at ${r.contractAddress}`);
}
writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));

// ---------- official lists ----------
const ownerSk = parseSecretKey(keys.owner.nsec);
const now = Math.floor(Date.now() / 1000);
const from = now - 60;
const listEvents = [
  createListEvent(
    "moderators",
    keys.moderators.map((m) => ({ pubkey: m.pubkey, x25519: m.x25519, name: m.name, from })),
    ownerSk,
    now,
  ),
  createListEvent(
    "service-keys",
    [
      { role: "owner", pubkey: keys.owner.pubkey, x25519: keys.owner.x25519, from },
      {
        role: "publisher",
        pubkey: keys.publisher.pubkey,
        x25519: keys.publisher.x25519,
        evm: publisherEvm.address,
        from,
      },
    ],
    ownerSk,
    now,
  ),
  createListEvent(
    "relays",
    RELAYS.map((url) => ({ url, operator: "own", country: "local" })),
    ownerSk,
    now,
  ),
  createListEvent(
    "gateways",
    [
      ...IPFS_GATEWAYS.map((url) => ({ url, network: "ipfs", operator: "own" })),
      { url: ARWEAVE, network: "arweave", operator: "own" },
    ],
    ownerSk,
    now,
  ),
  createListEvent("mirrors", [{ url: "http://localhost:5173" }], ownerSk, now),
];
writeFileSync(join(devDir, "list-events.json"), JSON.stringify(listEvents, null, 2));

const pool = new RelayPool({ websocketImplementation: WebSocket });
for (const e of listEvents) {
  const res = await pool.publish(RELAYS, e, 5000);
  const ok = res.filter((r) => r.ok).length;
  log(`published list ${e.tags.find((t) => t[0] === "d")[1]} to ${ok}/${RELAYS.length} relays`);
}
pool.close();

// ---------- config ----------
const config = {
  WARNING: "Local development configuration. Keys referenced here are samples.",
  ownerPubkey: keys.owner.pubkey,
  relays: RELAYS,
  ipfsApis: IPFS_APIS,
  ipfsGateways: IPFS_GATEWAYS,
  arweave: ARWEAVE,
  arweaveMaxVideoBytes: 50 * 1024 * 1024,
  chains,
  apiUrl: "http://127.0.0.1:8787",
  databaseUrl: "postgres://azaad:azaad@127.0.0.1:5432/azaadawaaz",
  stagingDir: ".dev/staging",
  workDir: ".dev/publisher-work",
  seedDir: ".dev/seed",
  requiredRelaySuccesses: RELAYS.length,
};
writeFileSync(join(devDir, "config.json"), JSON.stringify(config, null, 2));
mkdirSync(join(devDir, "staging"), { recursive: true });
log("wrote .dev/config.json");
log(`owner npub: ${keyPairFromSecret(ownerSk).npub}`);
log(`moderators: ${keys.moderators.map((m) => m.npub).join(", ")}`);
