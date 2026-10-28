import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/**
 * NIP-13 proof-of-work on a background thread. JS serialises the event with a nonce placeholder and passes the text
 * before and after it, so the hashed bytes are exactly what nostr-tools hashes; native only iterates nonces.
 */
export interface Spec extends TurboModule {
  /** Resolves with the first nonce (decimal string) ≥ startNonce whose hash has `difficulty` leading zero bits. */
  mine(jobId: string, prefix: string, suffix: string, difficulty: number, startNonce: number): Promise<string>;
  cancel(jobId: string): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadPow");
