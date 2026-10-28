import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registryAbi } from "@azaadawaaz/contracts";
import { storyIdToBytes16 } from "@azaadawaaz/schema";
import type { ChainConfig } from "./config.js";

export interface ReceiptResult {
  chain: string;
  chainId: number;
  registry: string;
  txHash?: Hex;
  blockNumber?: string;
  timestamp?: number;
  alreadyOnChain?: boolean;
}

/**
 * Write the tamper-proof receipt to one chain (spec §6 step 8). Idempotent: if the registry already holds a receipt
 * for (story, version) with the same hash we're done; a different hash is a hard error (should be impossible).
 * `onSent` is called with the transaction hash before waiting, so a crash mid-wait can resume by hash.
 */
export async function writeReceipt(args: {
  chain: ChainConfig;
  privateKey: Hex;
  storyId: string;
  version: number;
  manifestSha256: string;
  manifestCid: string;
  pendingTx?: Hex;
  onSent?: (tx: Hex) => Promise<void>;
}): Promise<ReceiptResult> {
  const chain = defineChain({
    id: args.chain.chainId,
    name: args.chain.key,
    nativeCurrency: { name: "native", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [args.chain.rpc] } },
  });
  const transport = http(args.chain.rpc, { timeout: 30_000, retryCount: 2 });
  const pub = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(args.privateKey);
  const wallet = createWalletClient({ chain, transport, account });
  const storyId = storyIdToBytes16(args.storyId);
  const sha = `0x${args.manifestSha256}` as Hex;
  const base = { chain: args.chain.key, chainId: args.chain.chainId, registry: args.chain.registry };

  const existing = async () => {
    const [onChainSha, ts] = (await pub.readContract({
      address: args.chain.registry,
      abi: registryAbi,
      functionName: "receipt",
      args: [storyId, args.version],
    })) as readonly [Hex, bigint];
    if (BigInt(onChainSha) === 0n) return null;
    if (onChainSha.toLowerCase() !== sha.toLowerCase())
      throw new Error(`chain ${args.chain.key} holds a different hash for this story version: ${onChainSha}`);
    return Number(ts);
  };

  if (args.pendingTx) {
    const r = await pub.waitForTransactionReceipt({ hash: args.pendingTx, timeout: 120_000 }).catch(() => null);
    if (r?.status === "success") {
      const block = await pub.getBlock({ blockNumber: r.blockNumber });
      return {
        ...base,
        txHash: args.pendingTx,
        blockNumber: r.blockNumber.toString(),
        timestamp: Number(block.timestamp),
      };
    }
  }
  const ts = await existing();
  if (ts !== null) return { ...base, alreadyOnChain: true, timestamp: ts };

  const { request } = await pub.simulateContract({
    address: args.chain.registry,
    abi: registryAbi,
    functionName: "publish",
    args: [storyId, args.version, sha, args.manifestCid],
    account,
  });
  const txHash = await wallet.writeContract(request);
  await args.onSent?.(txHash);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`receipt transaction reverted on ${args.chain.key}: ${txHash}`);
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  return { ...base, txHash, blockNumber: receipt.blockNumber.toString(), timestamp: Number(block.timestamp) };
}
