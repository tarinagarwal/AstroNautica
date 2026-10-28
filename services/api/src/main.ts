/** Run the API: migrate (unless AUTO_MIGRATE=false), load the signed lists, serve, and run the retention job. */
import { RelayPool } from "@azaadawaaz/core";
import WebSocket from "ws";
import { runCleanup } from "./cleanup.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { RelayAuditForwarder } from "./forwarder.js";
import { ListsService } from "./lists.js";
import { runMigrations } from "./migrate.js";
import { buildServer } from "./server.js";
import { StagingStore } from "./staging.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  if (config.autoMigrate) await runMigrations(pool);

  const relayPool = new RelayPool({ websocketImplementation: WebSocket });
  let log: { info(o: object, m?: string): void; warn(o: object, m?: string): void } = {
    info: () => {},
    warn: () => {},
  };
  const lists = new ListsService({
    ownerPubkey: config.ownerPubkey,
    relays: config.relays,
    pool: relayPool,
    refreshMs: config.listsRefreshSeconds * 1000,
    log: { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m) },
  });
  const forwarder = new RelayAuditForwarder(relayPool, () => lists.ownRelays(), {
    warn: (o, m) => log.warn(o, m),
  });
  const app = await buildServer({ config, pool, lists, forwarder });
  log = app.log;

  if (config.bootstrapListEvents) {
    const n = await lists.loadBootstrap(config.bootstrapListEvents);
    app.log.info({ accepted: n }, "loaded bootstrap list events");
  }
  await lists.start();
  if (!lists.ready())
    app.log.warn({}, "owner-signed moderator/service-key lists not found yet; retrying every refresh");

  const staging = new StagingStore(config.stagingDir);
  const cleanup = async () => {
    try {
      const r = await runCleanup({ pool, staging, rejectedRetentionDays: config.rejectedRetentionDays });
      app.log.info(r, "retention cleanup");
    } catch (e) {
      app.log.error({ err: e instanceof Error ? e.message : String(e) }, "retention cleanup failed");
    }
  };
  const cleanupTimer = setInterval(() => void cleanup(), config.cleanupIntervalMinutes * 60_000);
  cleanupTimer.unref();
  void cleanup();

  // The default "listening at http://<address>" line would put an address in the log.
  await app.listen({ port: config.port, host: config.host, listenTextResolver: () => "server listening" });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(cleanupTimer);
    lists.stop();
    await app.close();
    await forwarder.flush();
    relayPool.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
