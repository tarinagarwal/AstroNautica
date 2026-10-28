import { mkdirSync } from "node:fs";
import WebSocket from "ws";
import { RelayPool } from "@azaadawaaz/core";
import { loadConfig } from "./config.js";
import { PublisherDb } from "./db.js";
import { IpfsCluster } from "./ipfs.js";
import { ArweaveStore } from "./arweave.js";
import { Pipeline } from "./pipeline.js";
import { Worker } from "./worker.js";

/** Structured logs without IPs or secrets (spec §12). */
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }) + "\n");

async function main() {
  const config = loadConfig();
  if (process.env.NODE_ENV === "production") {
    if (config.pinningServices.length === 0)
      throw new Error("production requires at least one pinning service (spec §6 step 3)");
    if (config.ipfsApis.length < 2) throw new Error("production requires at least two IPFS nodes (spec §6 step 3)");
    if (config.arweaveDevMine) throw new Error("ARWEAVE_DEV_MINE must be off in production");
    if (!config.mediaUrl)
      throw new Error(
        "production requires MEDIA_URL: media parsers must run in the isolated media container (threat model §7)",
      );
  }
  mkdirSync(config.workDir, { recursive: true });
  mkdirSync(config.seedDir, { recursive: true });

  const db = new PublisherDb(config.databaseUrl);
  const relays = new RelayPool({ websocketImplementation: WebSocket });
  const ipfs = new IpfsCluster(config.ipfsApis);
  const arweave = new ArweaveStore(config.arweaveUrl, config.arweaveJwkPath, config.arweaveDevMine);
  const address = await arweave.init();
  log("publisher starting", {
    workerId: config.workerId,
    ipfsNodes: ipfs.size,
    chains: config.chains.map((c) => c.key),
    arweave: address,
  });

  const pipeline = new Pipeline({ config, db, relays, ipfs, arweave, log });
  const worker = new Worker(db, pipeline, { workerId: config.workerId, pollMs: config.pollMs, log });
  worker.start();

  const shutdown = async () => {
    log("publisher stopping");
    await worker.stop();
    relays.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  log("fatal", { error: String(e) });
  process.exit(1);
});
