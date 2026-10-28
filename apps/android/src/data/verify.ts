/**
 * The Verify panel's checks (spec §8.1): the announcing event, the manifest (hash, canonical form, approval signature,
 * moderator, publisher), the IPFS CID resolving block by block to the same bytes, the Arweave copy named by the
 * storage receipt, and the on-chain receipt on every configured chain. "Original and unedited" only when all pass.
 */
import { fetchVerified, sourcesFor, verifyEventStrict, wasPublisherAt, type ManifestCheck, type StoryRef } from "@azaadawaaz/core";
import { sha256Hex } from "@azaadawaaz/schema";
import type { Http } from "../platform/types";
import type { AppData } from "./appData";
import { checkChainReceipt, type ChainReceipt } from "./eth";
import { fetchLikeFrom } from "./gateways";
import { fetchFileByCid } from "./ipfs";

export type CheckState = "pending" | "ok" | "fail";

export interface VerifyResult {
  event: { state: CheckState };
  manifest: { state: CheckState; sha256: string; check?: ManifestCheck };
  ipfs: { state: CheckState; cid: string; gateway?: string; error?: string };
  arweave: { state: CheckState; tx?: string; gateway?: string; error?: "no-receipt" | "no-gateway" | "unreachable" };
  chains: { state: CheckState; receipts: ChainReceipt[]; error?: "no-chains" };
  flagged: string[];
  allOk: boolean;
}

export function initialVerify(ref: StoryRef): VerifyResult {
  return {
    event: { state: "pending" },
    manifest: { state: "pending", sha256: ref.manifestSha256 },
    ipfs: { state: "pending", cid: ref.manifestCid },
    arweave: { state: "pending" },
    chains: { state: "pending", receipts: [] },
    flagged: [],
    allOk: false,
  };
}

export function allChecksOk(r: Omit<VerifyResult, "allOk" | "flagged">): boolean {
  return (
    r.event.state === "ok" &&
    r.manifest.state === "ok" &&
    r.ipfs.state === "ok" &&
    r.arweave.state === "ok" &&
    r.chains.state === "ok"
  );
}

export async function verifyStory(
  app: AppData,
  http: Http,
  ref: StoryRef,
  onUpdate: (r: VerifyResult) => void,
): Promise<VerifyResult> {
  let r = initialVerify(ref);
  const update = (patch: Partial<VerifyResult>) => {
    const next = { ...r, ...patch };
    r = { ...next, flagged: app.gateways.flaggedSources(), allOk: allChecksOk(next) };
    onUpdate(r);
  };

  const eventOk = verifyEventStrict(ref.event) && !!app.lists && wasPublisherAt(app.lists, ref.publisher, ref.createdAt, ref.manifestSha256);
  update({ event: { state: eventOk ? "ok" : "fail" } });

  const tasks: Promise<void>[] = [];

  tasks.push(
    app
      .loadManifest(ref)
      .then((m) => update({ manifest: { state: m.check.ok ? "ok" : "fail", sha256: ref.manifestSha256, check: m.check } }))
      .catch(() => update({ manifest: { state: "fail", sha256: ref.manifestSha256 } })),
  );

  tasks.push(
    (async () => {
      let gateway: string | undefined;
      try {
        const bytes = await fetchFileByCid(
          ref.manifestCid,
          app.gateways.blockSource({
            noCache: true,
            onReport: (x) => {
              if (x.ok && !gateway) gateway = x.base;
            },
          }),
          4 * 1024 * 1024,
        );
        const ok = sha256Hex(bytes) === ref.manifestSha256;
        update({ ipfs: { state: ok ? "ok" : "fail", cid: ref.manifestCid, gateway, error: ok ? undefined : "mismatch" } });
      } catch (e) {
        update({ ipfs: { state: "fail", cid: ref.manifestCid, error: e instanceof Error ? e.message : String(e) } });
      }
    })(),
  );

  tasks.push(
    (async () => {
      const receipt = await app.storageReceipt(ref.storyId, ref.version).catch(() => undefined);
      const tx = receipt?.arweave[ref.manifestSha256];
      if (!tx) return update({ arweave: { state: "fail", error: "no-receipt" } });
      const sources = sourcesFor({ arweave: tx }, app.gateways.list(), app.gateways.scoreboard);
      if (!sources.length) return update({ arweave: { state: "fail", tx, error: "no-gateway" } });
      let gateway: string | undefined;
      try {
        await fetchVerified({
          sources,
          sha256: ref.manifestSha256,
          scoreboard: app.gateways.scoreboard,
          fetch: fetchLikeFrom(http, 4 * 1024 * 1024),
          maxBytes: 4 * 1024 * 1024,
          onReport: (x) => {
            if (x.ok) gateway = new URL(x.url).origin;
          },
        });
        update({ arweave: { state: "ok", tx, gateway } });
      } catch {
        update({ arweave: { state: "fail", tx, error: "unreachable" } });
      }
    })(),
  );

  tasks.push(
    (async () => {
      const chains = app.config.chains;
      if (!chains.length || !app.lists) return update({ chains: { state: "fail", receipts: [], error: "no-chains" } });
      const receipts = await Promise.all(
        chains.map((c) => checkChainReceipt(http, c, ref.storyId, ref.version, ref.manifestSha256, app.lists!)),
      );
      update({ chains: { state: receipts.every((x) => x.ok) ? "ok" : "fail", receipts } });
    })(),
  );

  await Promise.all(tasks);
  update({});
  return r;
}
