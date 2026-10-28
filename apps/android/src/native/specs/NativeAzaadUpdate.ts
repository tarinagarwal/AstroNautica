import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/** Self-update (spec §8.2): inspect a downloaded APK's signing certificate and hand it to the system installer. */
export interface Spec extends TurboModule {
  /** {"packageName","versionName","versionCode"} */
  appInfo(): string;
  /** {"packageName","versionName","versionCode","certSha256":[hex…]} (from PackageManager.getPackageArchiveInfo) */
  apkInfo(path: string): Promise<string>;
  /** JSON array of the installed app's signing certificate SHA-256s (hex). */
  ownCertSha256(): Promise<string>;
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  /** FileProvider + ACTION_VIEW with the package-archive MIME type. */
  install(path: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadUpdate");
