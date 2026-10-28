import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/**
 * libsodium (via lazysodium) for staging encryption. Synchronous so it can back a libsodium-wrappers-compatible
 * adapter (src/crypto/sodiumNative.ts) under packages/core's unchanged staging code. Bytes cross as standard base64.
 */
export interface Spec extends TurboModule {
  randomBytes(length: number): string;
  /** {"publicKey","privateKey"} */
  boxKeypair(): string;
  scalarmultBase(privateKeyB64: string): string;
  boxSeal(messageB64: string, publicKeyB64: string): string;
  /** null when the box does not open with this key pair. */
  boxSealOpen(cipherB64: string, publicKeyB64: string, privateKeyB64: string): string | null;
  secretstreamKeygen(): string;
  /** {"state":number,"header":b64} */
  secretstreamInitPush(keyB64: string): string;
  secretstreamPush(state: number, messageB64: string, tag: number): string;
  /** A state handle, or -1 when the header is invalid. */
  secretstreamInitPull(headerB64: string, keyB64: string): number;
  /** {"message":b64,"tag":number}, or null when the chunk fails authentication. */
  secretstreamPull(state: number, cipherB64: string): string | null;
  secretstreamFree(state: number): void;
  /** Encrypt a file into 1 MiB secretstream chunks on disk: {"src","outDir","keyB64","chunkSize"} → {"header","chunks":[{"n","size","sha256"}],"plainSha256","plainSize"} */
  encryptFile(requestJson: string): Promise<string>;
  /** Decrypt chunk files into one plaintext file: {"header","keyB64","chunkPaths":[],"dest"} → {"sha256","size"} */
  decryptChunks(requestJson: string): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadSodium");
