/**
 * Integration with the shared local dev network (infra/dev): real relays and IPFS gateways, read-only.
 * Runs only with TEST_DEVNET=1 (e.g. `TEST_DEVNET=1 pnpm --filter @azaadawaaz/android test -- devnet`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { RelayPool } from "@azaadawaaz/core";
import { normalizeConfig } from "../../config";
import { JsonStore } from "../../platform/kv";
import { nodeFs, nodeHttp } from "../../test/nodePlatform";
import { AppData } from "../appData";
import { GatewayClient } from "../gateways";

const root = resolve(__dirname, "../../../../..");
const enabled = process.env.TEST_DEVNET === "1" && existsSync(resolve(root, ".dev/config.json"));

(enabled ? describe : describe.skip)("dev network (read-only)", () => {
  it("loads the owner-signed lists from the local relays and reads published stories", async () => {
    const dev = JSON.parse(readFileSync(resolve(root, ".dev/config.json"), "utf8"));
    const listEvents = JSON.parse(readFileSync(resolve(root, ".dev/list-events.json"), "utf8"));
    const fs = nodeFs();
    const pool = new RelayPool({ websocketImplementation: WebSocket });
    const app = new AppData(
      normalizeConfig({ ownerPubkey: dev.ownerPubkey, bootstrapRelays: dev.relays, listEvents, chains: dev.chains }),
      pool,
      new GatewayClient(nodeHttp),
      new JsonStore(fs, "d"),
      fs,
    );
    await app.refresh();
    app.unwatch();
    expect(app.listsStatus).toBe("ready");
    expect(app.relaysUnreachable).toBe(false);
    for (const s of app.stories.slice(0, 3)) {
      const m = await app.loadManifest(s);
      expect(m.check.ok).toBe(true);
    }
    console.log(`devnet: ${app.lists?.moderators.length} moderators, ${app.stories.length} stories`);
    pool.close();
  }, 60_000);
});
