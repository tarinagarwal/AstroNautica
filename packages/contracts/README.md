# @azaadawaaz/contracts

`AzaadAwaazRegistry`: the on-chain receipt contract from SPEC §9. The publishing pipeline (SPEC §6 step 8) calls
`publish(storyId, version, manifestSha256, manifestCid)` on every configured EVM chain. The defaults are Base and BNB
Smart Chain (decisions D7).

The contract is small and cannot be changed after deployment:

- There is no proxy, no `selfdestruct`, no payable function, and no way to delete or edit a receipt.
- `owner` is set in the constructor and can never be transferred. Its only power is `setPublisher(next)`.
- `publisher` is the only address that can call `publish`.
- Rules for `publish`:
  - `storyId` must not be zero.
  - `version` must be at least 1 and strictly greater than `latestVersion(storyId)`, so each `(storyId, version)` pair
    is written at most once.
  - `manifestSha256` must not be zero.
  - `manifestCid` must be 1 to 128 bytes long.
- Reads: `receipt(storyId, version)` returns `(manifestSha256, timestamp)` and `latestVersion(storyId)` returns the
  latest version. Both return zeros for anything never published.
- Errors are custom errors: `NotOwner`, `NotPublisher`, `ZeroAddress`, `InvalidStoryId`, `InvalidVersion`,
  `AlreadyPublished`, `VersionNotIncreasing`, `EmptyManifestHash`, `EmptyManifestCid` and `ManifestCidTooLong`.

## Layout

| Path | What |
| --- | --- |
| `src/AzaadAwaazRegistry.sol` | The contract |
| `test/AzaadAwaazRegistry.t.sol` | Unit, access-control, event and fuzz tests, plus gas snapshots |
| `test/AzaadAwaazRegistry.invariant.t.sol` | Stateful invariant test against a ghost model |
| `script/Deploy.s.sol` | Deploy script; reads `OWNER` and `PUBLISHER` from the environment |
| `deploy-local.sh` | Deploys to a running RPC node and writes `deployments/<chainId>.json` |
| `abi/AzaadAwaazRegistry.json` | ABI array (generated) |
| `src/index.ts`, `src/abi.ts`, `src/chains.ts` | TypeScript exports: `registryAbi` (`as const`, for viem) and `chains` |
| `.gas-snapshot`, `snapshots/` | Gas snapshots (`forge snapshot`, `vm.snapshotGasLastCall`) |
| `lib/forge-std` | Vendored forge-std v1.17.0 (installed with `--no-git`) |

The compiler is pinned to solc `0.8.28` with `evm_version = "paris"`. Paris has no `PUSH0`, `MCOPY` or transient
storage, so the same bytecode runs on any EVM chain we add later. The optimizer is on with 10,000 runs.

## Test

```sh
cd packages/contracts
forge build
forge test -vv                 # 49 tests: unit, fuzz (1024 runs), invariants
forge fmt --check
forge snapshot --check --no-match-test 'testFuzz|invariant'   # gas regression check
FOUNDRY_PROFILE=ci forge test  # 10,000 fuzz runs
```

From the monorepo root, `pnpm --filter @azaadawaaz/contracts test` runs `forge test`.

Gas measured by `vm.snapshotGasLastCall` (in `snapshots/`):

- First version of a story: about 73k gas.
- A correction (a new version of an existing story): about 49k gas.
- `setPublisher`: about 7k gas.

These numbers leave out the 21k base transaction cost and calldata.

## TypeScript package

```ts
import { registryAbi, chains, defaultChainKeys } from "@azaadawaaz/contracts";
import { createPublicClient, http } from "viem";

const client = createPublicClient({ transport: http(chains.base.rpcUrls[0]) });
const [sha, ts] = await client.readContract({
  address: "0x…",
  abi: registryAbi,
  functionName: "receipt",
  args: ["0x0192f0c1a2b34c5d8e9f00112233aabb", 1],
});
```

`chains` covers Base (8453), Base Sepolia (84532), BNB Smart Chain (56), BSC testnet (97) and local anvil (31337). Each
entry has public RPC URLs and its explorer. Use your own or a paid RPC endpoint in production.

After changing the contract, regenerate the ABI files and commit them:

```sh
pnpm --filter @azaadawaaz/contracts abi        # forge build + writes abi/*.json and src/abi.ts
pnpm --filter @azaadawaaz/contracts abi:check  # fails if they are stale (for CI)
```

## Deploy to a local anvil

```sh
anvil                            # in another terminal
./deploy-local.sh                # default RPC http://127.0.0.1:8545, anvil key #0
./deploy-local.sh http://127.0.0.1:9545   # or pass an RPC URL
```

By default, anvil account #0 is the deployer and owner, and account #1
(`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`) is the publisher. Override them with `PRIVATE_KEY`, `OWNER` and
`PUBLISHER`. The script starts nothing itself. It writes `deployments/<chainId>.json` with the address, chain id,
owner, publisher, transaction hash and block. `deployments/31337.json` is gitignored.

Try it:

```sh
ADDR=$(node -p 'require("./deployments/31337.json").address')
PUB_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # anvil account #1
cast send $ADDR "publish(bytes16,uint32,bytes32,string)" \
  0x0192f0c1a2b34c5d8e9f00112233aabb 1 0x$(printf manifest | sha256sum | cut -d' ' -f1) \
  bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi --private-key $PUB_KEY
cast logs --from-block 0 --address $ADDR "Published(bytes16 indexed,uint32,bytes32,string,uint64)"
cast call $ADDR "receipt(bytes16,uint32)(bytes32,uint64)" 0x0192f0c1a2b34c5d8e9f00112233aabb 1
```

## Deploy to Base and BNB Smart Chain

Before deploying:

- **Owner:** an offline EVM key (a hardware wallet). It never needs gas unless you rotate the publisher.
- **Publisher:** the hot key the publishing worker uses. Fund it with a little ETH on Base and a little BNB on BSC.
- **Deployer:** any funded key. It has no special rights after deployment.

To get the same contract address on every chain, deploy from a fresh deployer key whose nonce is the same on each
chain (for example 0).

```sh
export OWNER=0x…        # offline owner key
export PUBLISHER=0x…    # pipeline hot key
cast wallet import deployer --interactive   # once; stores an encrypted keystore

# Testnets first
forge script script/Deploy.s.sol:Deploy --rpc-url base_sepolia --account deployer --broadcast
forge script script/Deploy.s.sol:Deploy --rpc-url bsc_testnet  --account deployer --broadcast

# Mainnets
forge script script/Deploy.s.sol:Deploy --rpc-url base --account deployer --broadcast
forge script script/Deploy.s.sol:Deploy --rpc-url bsc  --account deployer --broadcast
```

The RPC aliases `base`, `base_sepolia`, `bsc` and `bsc_testnet` are defined in `foundry.toml` with public endpoints.
You can pass any URL instead. Use `--ledger` or `--trezor` in place of `--account` for hardware wallets.
`deploy-local.sh` also works against any RPC:

```sh
RPC_URL=https://sepolia.base.org PRIVATE_KEY=0x… OWNER=0x… PUBLISHER=0x… ./deploy-local.sh
```

It writes `deployments/84532.json`. Commit `deployments/<chainId>.json` for every real chain.

Record each deployed address in the pipeline's chain config. Then check the deployment:

```sh
cast call <address> "owner()(address)" --rpc-url base
cast call <address> "publisher()(address)" --rpc-url base
```

## Verify the source

Verify on both the chain's explorer and Sourcify (SPEC §9). The constructor arguments are the ABI-encoded `OWNER` and
`PUBLISHER`:

```sh
ARGS=$(cast abi-encode "constructor(address,address)" $OWNER $PUBLISHER)
```

**Explorers (Basescan, BscScan).** Use an Etherscan API key. A single Etherscan V2 key covers both Base and BSC.

```sh
export ETHERSCAN_API_KEY=…

forge verify-contract <address> src/AzaadAwaazRegistry.sol:AzaadAwaazRegistry \
  --chain base --constructor-args $ARGS --verifier etherscan --watch
forge verify-contract <address> src/AzaadAwaazRegistry.sol:AzaadAwaazRegistry \
  --chain bsc --constructor-args $ARGS --verifier etherscan --watch
# testnets: --chain base-sepolia / --chain bsc-testnet
```

**Sourcify.** No API key is needed.

```sh
forge verify-contract <address> src/AzaadAwaazRegistry.sol:AzaadAwaazRegistry \
  --chain base --constructor-args $ARGS --verifier sourcify
forge verify-contract <address> src/AzaadAwaazRegistry.sol:AzaadAwaazRegistry \
  --chain bsc --constructor-args $ARGS --verifier sourcify

forge verify-check --chain base --verifier sourcify <address>   # confirm the match
```

You can also verify while deploying: add `--verify --verifier etherscan` (with `ETHERSCAN_API_KEY` set) to the
`forge script` command, then run the Sourcify command above. The build metadata hash is `ipfs`. Because of this,
Sourcify can give a full (perfect) match when the sources match exactly.

## Offline builds

`forge build` downloads solc 0.8.28 on first use. If `binaries.soliditylang.org` is blocked, set
`FOUNDRY_SOLC=/path/to/solc-0.8.28` (and `FOUNDRY_OFFLINE=true`) to use a compiler you already have. The repo ships
a wrapper around the npm build of the same compiler (`solc@0.8.28`, a dev dependency):

```sh
pnpm install
FOUNDRY_SOLC=$PWD/scripts/solcjs FOUNDRY_OFFLINE=true forge test
```
