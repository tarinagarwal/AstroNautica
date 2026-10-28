import { storyIdToBytes16 } from "@azaadawaaz/schema";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { normalizeConfig } from "../../config";
import { JsonStore } from "../../platform/kv";
import { fakeHttp, nodeFs } from "../../test/nodePlatform";
import { GATEWAY, MemoryPool, PUBLISHER_EVM, gatewayHandler, owner, ownerLists, publishStory } from "../../test/fixtures";
import { AppData } from "../appData";
import { PUBLISHED_TOPIC, RECEIPT_SELECTOR, decodePublishedData, decodeReceipt, encodeReceiptCall } from "../eth";
import { GatewayClient } from "../gateways";
import { verifyStory } from "../verify";

const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

/** A JSON-RPC registry: receipt(bytes16,uint32,address) and Published logs, keyed like the contract. */
function chainHandler(receipts: Map<string, { sha: string; timestamp: number; cid: string; by: string }>) {
  return (body: { method: string; params: any[] }) => {
    if (body.method === "eth_call") {
      const data: string = body.params[0].data;
      const key = data.slice(10);
      const r = receipts.get(key);
      return r ? "0x" + r.sha + word(r.timestamp.toString(16)) : "0x" + "0".repeat(128);
    }
    if (body.method === "eth_getLogs") {
      for (const [key, r] of receipts) {
        if (body.params[0].topics[3] !== "0x" + word(r.by.slice(2))) continue;
        if (!key.startsWith(body.params[0].topics[1].slice(2, 34))) continue;
        const cidHex = Buffer.from(r.cid).toString("hex");
        const data = "0x" + r.sha + word("60") + word(r.timestamp.toString(16)) + word(r.cid.length.toString(16)) + cidHex.padEnd(Math.ceil(cidHex.length / 64) * 64, "0");
        return [{ data, topics: body.params[0].topics, transactionHash: "0x" + "ee".repeat(32), blockNumber: "0x10" }];
      }
      return [];
    }
    throw new Error(`unexpected ${body.method}`);
  };
}

function setup(receiptBy: string, receiptSha?: string) {
  const fs = nodeFs();
  const story = publishStory();
  const pool = new MemoryPool([...ownerLists(), story.event, story.receipt]);
  const receipts = new Map([
    [
      encodeReceiptCall(story.manifest.id, 1, receiptBy).slice(10),
      { sha: receiptSha ?? story.sha, timestamp: Math.floor(Date.parse(story.manifest.publishedAt) / 1000) + 5, cid: story.cid, by: receiptBy },
    ],
  ]);
  const rpc = chainHandler(receipts);
  const gw = gatewayHandler(story.files, { arweave: new Map([[story.arweaveTx, story.bytes]]) });
  const http = fakeHttp((req) => {
    if (req.url.startsWith("https://rpc.example")) {
      const body = JSON.parse(new TextDecoder().decode(req.body));
      return { body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: rpc(body) }) };
    }
    return gw(req);
  }, fs);
  const config = normalizeConfig({
    ownerPubkey: owner.pubkey,
    chains: [{ key: "base-local", chainId: 31337, rpc: "https://rpc.example", registry: "0x" + "11".repeat(20) }],
  });
  const app = new AppData(config, pool, new GatewayClient(http), new JsonStore(fs, "d"), fs);
  return { app, http, story };
}

describe("Verify", () => {
  it("uses the new registry ABI", () => {
    expect(RECEIPT_SELECTOR).toBe("0x" + bytesToHex(keccak_256(utf8ToBytes("receipt(bytes16,uint32,address)"))).slice(0, 8));
    expect(PUBLISHED_TOPIC).toBe("0x" + bytesToHex(keccak_256(utf8ToBytes("Published(bytes16,uint32,address,bytes32,string,uint64)"))));
    const call = encodeReceiptCall("01928f3e-7c1a-7b2c-8d3e-4f5a6b7c8d9e", 3, PUBLISHER_EVM);
    expect(call.slice(10, 42)).toBe(storyIdToBytes16("01928f3e-7c1a-7b2c-8d3e-4f5a6b7c8d9e").slice(2));
    expect(call.length).toBe(10 + 64 * 3);
    expect(decodeReceipt("0x" + "0".repeat(128))).toBeUndefined();
    const d = decodePublishedData("0x" + "aa".repeat(32) + word("60") + word("2a") + word("3") + Buffer.from("abc").toString("hex").padEnd(64, "0"));
    expect(d).toEqual({ sha: "aa".repeat(32), cid: "abc", timestamp: 42 });
  });

  it("shows original and unedited when every check passes", async () => {
    const { app, story, http } = setup(PUBLISHER_EVM);
    await app.refresh();
    const updates: boolean[] = [];
    const result = await verifyStory(app, http, app.stories[0]!, (r) => updates.push(r.allOk));
    expect(updates.length).toBeGreaterThan(3);
    expect(result.event.state).toBe("ok");
    expect(result.manifest.state).toBe("ok");
    expect(result.ipfs.state).toBe("ok");
    expect(result.arweave).toMatchObject({ state: "ok", tx: story.arweaveTx });
    expect(result.chains.state).toBe("ok");
    expect(result.chains.receipts[0]).toMatchObject({ ok: true, by: PUBLISHER_EVM, txHash: "0x" + "ee".repeat(32), manifestCid: story.cid });
    expect(result.allOk).toBe(true);
    app.unwatch();
  });

  it("fails when the chain holds a different hash or the receipt was written by another address", async () => {
    const a = setup(PUBLISHER_EVM, "ff".repeat(32));
    await a.app.refresh();
    const ra = await verifyStory(a.app, a.http, a.app.stories[0]!, () => undefined);
    expect(ra.chains.receipts[0]!.error).toBe("mismatch");
    expect(ra.allOk).toBe(false);
    a.app.unwatch();
    // A receipt by an address that isn't the publisher's EVM key isn't even looked up.
    const b = setup("0x" + "cd".repeat(20));
    await b.app.refresh();
    const rb = await verifyStory(b.app, b.http, b.app.stories[0]!, () => undefined);
    expect(rb.chains.receipts[0]!.error).toBe("not-found");
    expect(rb.allOk).toBe(false);
    b.app.unwatch();
  });

  it("flags a gateway serving altered manifest bytes and still verifies via another", async () => {
    const story = publishStory();
    const fs = nodeFs();
    const http = fakeHttp(gatewayHandler(story.files, { tamper: new Set([GATEWAY]) }), fs);
    const app = new AppData(normalizeConfig({ ownerPubkey: owner.pubkey }), new MemoryPool([...ownerLists(), story.event]), new GatewayClient(http), new JsonStore(fs, "d"), fs);
    await app.refresh();
    const r = await verifyStory(app, http, app.stories[0]!, () => undefined);
    expect(r.ipfs.state).toBe("ok");
    expect(r.flagged).toContain(GATEWAY);
    expect(r.chains.error).toBe("no-chains");
    expect(r.allOk).toBe(false);
    app.unwatch();
  });
});
