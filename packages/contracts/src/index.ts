export { registryAbi } from "./abi.js";
export {
  chains,
  defaultChainKeys,
  chainById,
  explorerTxUrl,
  explorerAddressUrl,
  type ChainKey,
  type RegistryChain,
} from "./chains.js";

/** Maximum manifest CID length accepted by the contract, in bytes (UTF-8). */
export const MAX_MANIFEST_CID_LENGTH = 128;
