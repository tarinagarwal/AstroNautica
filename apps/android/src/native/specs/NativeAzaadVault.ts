import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/**
 * Key storage (spec §8.2, §12): secrets are encrypted with a non-exportable Android Keystore AES key. With an app lock,
 * they are also encrypted with a key derived from the PIN; biometric unlock releases that key through a
 * biometric-bound Keystore key (BiometricPrompt CryptoObject).
 */
export interface Spec extends TurboModule {
  /** {"hasVault","lock":"none"|"pin","biometric","biometricAvailable","unlocked","failedAttempts","retryAt"} */
  state(): Promise<string>;
  /** Store the secrets JSON (requires unlocked when a lock is set). */
  write(secretsJson: string): Promise<void>;
  /** The secrets JSON, or "{}" when none (requires unlocked when a lock is set). */
  read(): Promise<string>;
  setPin(pin: string): Promise<void>;
  removePin(): Promise<void>;
  /** {"ok","attemptsLeft","retryAt"} */
  unlockWithPin(pin: string): Promise<string>;
  enableBiometric(title: string, subtitle: string, cancel: string): Promise<boolean>;
  disableBiometric(): Promise<void>;
  unlockWithBiometric(title: string, subtitle: string, cancel: string): Promise<boolean>;
  lock(): void;
  wipe(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadVault");
