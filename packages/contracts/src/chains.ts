/** EVM chains that can hold AzaadAwaazRegistry receipts (SPEC §6 step 8, §9; decisions D7). */
export interface RegistryChain {
  /** EIP-155 chain id. */
  readonly id: number;
  /** Stable key used in config files and logs. */
  readonly key: ChainKey;
  readonly name: string;
  readonly testnet: boolean;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: 18 };
  /** Free public RPC endpoints, most reliable first. Production should add its own (or a paid) endpoint in front. */
  readonly rpcUrls: readonly string[];
  /** Block explorer (empty for local). */
  readonly explorer: { readonly name: string; readonly url: string; readonly apiUrl: string } | null;
}

export type ChainKey = "base" | "baseSepolia" | "bsc" | "bscTestnet" | "anvil";

export const chains = {
  base: {
    id: 8453,
    key: "base",
    name: "Base",
    testnet: false,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com"],
    explorer: { name: "Basescan", url: "https://basescan.org", apiUrl: "https://api.basescan.org/api" },
  },
  baseSepolia: {
    id: 84532,
    key: "baseSepolia",
    name: "Base Sepolia",
    testnet: true,
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    explorer: {
      name: "Basescan Sepolia",
      url: "https://sepolia.basescan.org",
      apiUrl: "https://api-sepolia.basescan.org/api",
    },
  },
  bsc: {
    id: 56,
    key: "bsc",
    name: "BNB Smart Chain",
    testnet: false,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-rpc.publicnode.com",
    ],
    explorer: { name: "BscScan", url: "https://bscscan.com", apiUrl: "https://api.bscscan.com/api" },
  },
  bscTestnet: {
    id: 97,
    key: "bscTestnet",
    name: "BNB Smart Chain Testnet",
    testnet: true,
    nativeCurrency: { name: "Test BNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: [
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
      "https://bsc-testnet-rpc.publicnode.com",
    ],
    explorer: {
      name: "BscScan Testnet",
      url: "https://testnet.bscscan.com",
      apiUrl: "https://api-testnet.bscscan.com/api",
    },
  },
  anvil: {
    id: 31337,
    key: "anvil",
    name: "Anvil (local)",
    testnet: true,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["http://127.0.0.1:8545"],
    explorer: null,
  },
} as const satisfies Record<ChainKey, RegistryChain>;

/** Default receipt chains for production (decisions D7). */
export const defaultChainKeys = ["base", "bsc"] as const satisfies readonly ChainKey[];

const byId: ReadonlyMap<number, RegistryChain> = new Map(Object.values(chains).map((c) => [c.id, c]));

/** Look up a supported chain by EIP-155 id. */
export function chainById(id: number): RegistryChain | undefined {
  return byId.get(id);
}

/** Explorer link for a transaction, or undefined for chains without an explorer. */
export function explorerTxUrl(chain: RegistryChain, txHash: string): string | undefined {
  return chain.explorer ? `${chain.explorer.url}/tx/${txHash}` : undefined;
}

/** Explorer link for an address, or undefined for chains without an explorer. */
export function explorerAddressUrl(chain: RegistryChain, address: string): string | undefined {
  return chain.explorer ? `${chain.explorer.url}/address/${address}` : undefined;
}
