import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Arweave from "arweave";
import type { JWKInterface } from "arweave/node/lib/wallet.js";

export const APP_NAME = "AzaadAwaaz";

export interface ArweaveUpload {
  sha256: string;
  data: Uint8Array;
  contentType: string;
  storyId: string;
}

/**
 * Uploads to Arweave with arweave-js (decision D10). Every upload is tagged `App-Name`, `Story-Id` and
 * `Content-SHA256` (spec §6 step 4), which also makes uploads idempotent: before uploading we look for an existing
 * transaction from our wallet with the same hash.
 */
export class ArweaveStore {
  private readonly ar: Arweave;
  private jwk!: JWKInterface;
  private address!: string;

  constructor(
    private readonly url: string,
    private readonly jwkPath: string | undefined,
    private readonly devMine: boolean,
  ) {
    const u = new URL(url);
    this.ar = Arweave.init({
      host: u.hostname,
      port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
      protocol: u.protocol.replace(":", ""),
      timeout: 60_000,
    });
  }

  async init(): Promise<string> {
    if (this.jwkPath && existsSync(this.jwkPath)) {
      this.jwk = JSON.parse(readFileSync(this.jwkPath, "utf8"));
    } else if (this.devMine) {
      // ArLocal only: create a throwaway wallet. A production wallet must be provided (ARWEAVE_JWK).
      this.jwk = await this.ar.wallets.generate();
      if (this.jwkPath) {
        mkdirSync(dirname(this.jwkPath), { recursive: true });
        writeFileSync(this.jwkPath, JSON.stringify(this.jwk), { mode: 0o600 });
      }
    } else {
      throw new Error("ARWEAVE_JWK is required outside development");
    }
    this.address = await this.ar.wallets.jwkToAddress(this.jwk);
    if (this.devMine) await this.ar.api.get(`mint/${this.address}/1000000000000000`);
    return this.address;
  }

  /** Find a transaction we already made for this content hash. */
  async findExisting(sha256: string): Promise<string | null> {
    const query = `query($owner: String!, $sha: String!) {
      transactions(owners: [$owner], tags: [{ name: "App-Name", values: ["${APP_NAME}"] }, { name: "Content-SHA256", values: [$sha] }], first: 1) {
        edges { node { id } }
      }
    }`;
    try {
      const res = await this.ar.api.post("graphql", { query, variables: { owner: this.address, sha: sha256 } });
      return (res.data as any)?.data?.transactions?.edges?.[0]?.node?.id ?? null;
    } catch {
      return null;
    }
  }

  async upload(u: ArweaveUpload): Promise<string> {
    const existing = await this.findExisting(u.sha256);
    if (existing) return existing;
    const tx = await this.ar.createTransaction({ data: u.data }, this.jwk);
    tx.addTag("Content-Type", u.contentType);
    tx.addTag("App-Name", APP_NAME);
    tx.addTag("Story-Id", u.storyId);
    tx.addTag("Content-SHA256", u.sha256);
    await this.ar.transactions.sign(tx, this.jwk);
    const uploader = await this.ar.transactions.getUploader(tx);
    while (!uploader.isComplete) await uploader.uploadChunk();
    if (uploader.lastResponseStatus >= 400)
      throw new Error(`Arweave upload failed: HTTP ${uploader.lastResponseStatus}`);
    if (this.devMine) await this.ar.api.get("mine");
    return tx.id;
  }

  /** Download a transaction's data (used by tests and the rebuild script). */
  async get(txid: string): Promise<Uint8Array> {
    const data = await this.ar.transactions.getData(txid, { decode: true });
    return typeof data === "string" ? new TextEncoder().encode(data) : data;
  }
}
