/**
 * The Verify panel's checks (spec §8.1): manifest hash and signatures, the IPFS CID resolving to the same bytes, the
 * Arweave copy from the storage receipt, and the on-chain receipt on every configured chain. "Original and unedited"
 * only when every check passes.
 */
import { fetchVerified, sourcesFor } from "@core/fetch.js";
import type { ManifestCheck, StoryRef } from "@core/stories.js";
import { sha256Hex } from "@azaadawaaz/schema";
import { verifyEventStrict } from "@core/keys.js";
import { wasPublisherAt } from "@core/lists.js";
import type { AppData } from "./appData.js";
import { blockSource, flaggedSources, gatewayFetch, getGateways, scoreboard } from "../lib/gateways.js";
import { fetchFileByCid } from "../lib/ipfs.js";
import { checkChainReceipt, type ChainReceipt } from "../lib/eth.js";

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

const done = (r: VerifyResult): VerifyResult => ({
  ...r,
  flagged: flaggedSources(),
  allOk:
    r.event.state === "ok" &&
    r.manifest.state === "ok" &&
    r.ipfs.state === "ok" &&
    r.arweave.state === "ok" &&
    r.chains.state === "ok",
});

export async function verifyStory(
  app: AppData,
  ref: StoryRef,
  onUpdate: (r: VerifyResult) => void,
  rpcFetch?: typeof fetch,
): Promise<VerifyResult> {
  let r = initialVerify(ref);
  const update = (patch: Partial<VerifyResult>) => {
    r = done({ ...r, ...patch });
    onUpdate(r);
  };

  // 1. The announcing event: signed by a publisher key valid at the time.
  const eventOk =
    verifyEventStrict(ref.event) && !!app.lists && wasPublisherAt(app.lists, ref.publisher, ref.createdAt);
  update({ event: { state: eventOk ? "ok" : "fail" } });

  const tasks: Promise<void>[] = [];

  // 2. Manifest bytes, hash, approval signature, moderator and publisher.
  tasks.push(
    app
      .loadManifest(ref)
      .then((m) =>
        update({ manifest: { state: m.check.ok ? "ok" : "fail", sha256: ref.manifestSha256, check: m.check } }),
      )
      .catch(() => update({ manifest: { state: "fail", sha256: ref.manifestSha256 } })),
  );

  // 3. IPFS: the CID resolves (verified block by block, no cache) to bytes with the manifest's hash.
  tasks.push(
    (async () => {
      let gateway: string | undefined;
      const src = blockSource();
      const base = src.onReport;
      try {
        const bytes = await fetchFileByCid(
          ref.manifestCid,
          {
            ...src,
            noCache: true,
            onReport: (x) => {
              base?.(x);
              if (x.ok && !gateway) gateway = x.base;
            },
          },
          4 * 1024 * 1024,
        );
        const ok = sha256Hex(bytes) === ref.manifestSha256;
        update({
          ipfs: { state: ok ? "ok" : "fail", cid: ref.manifestCid, gateway, error: ok ? undefined : "mismatch" },
        });
      } catch (e) {
        update({ ipfs: { state: "fail", cid: ref.manifestCid, error: e instanceof Error ? e.message : String(e) } });
      }
    })(),
  );

  // 4. Arweave: the storage receipt names the transaction; the bytes there must match the manifest hash.
  tasks.push(
    (async () => {
      const receipt = await app.storageReceipt(ref.storyId, ref.version).catch(() => undefined);
      const tx = receipt?.arweave[ref.manifestSha256];
      if (!tx) return update({ arweave: { state: "fail", error: "no-receipt" } });
      const sources = sourcesFor({ arweave: tx }, getGateways(), scoreboard);
      if (!sources.length) return update({ arweave: { state: "fail", tx, error: "no-gateway" } });
      let gateway: string | undefined;
      try {
        await fetchVerified({
          sources,
          sha256: ref.manifestSha256,
          scoreboard,
          fetch: (u, i) => gatewayFetch(u, i),
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

  // 5. On-chain receipts on every configured chain.
  tasks.push(
    (async () => {
      const chains = app.config.chains;
      if (!chains.length) return update({ chains: { state: "fail", receipts: [], error: "no-chains" } });
      const receipts = await Promise.all(
        chains.map((c) => checkChainReceipt(c, ref.storyId, ref.version, ref.manifestSha256, rpcFetch)),
      );
      update({ chains: { state: receipts.every((x) => x.ok) ? "ok" : "fail", receipts } });
    })(),
  );

  await Promise.all(tasks);
  r = done(r);
  onUpdate(r);
  return r;
}
