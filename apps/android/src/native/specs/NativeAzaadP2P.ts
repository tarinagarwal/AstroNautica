import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/**
 * Phone-to-phone transfer of story bundles over Wi-Fi Direct (android.net.wifi.p2p), no Play Services.
 * Events "azaadP2p": {"type":"peers","peers":[{"name","address","status"}]} | {"type":"state",…} |
 * {"type":"progress","bytes","total"} | {"type":"received","path","size","sha256"} | {"type":"sent"} | {"type":"error","message"}
 */
export interface Spec extends TurboModule {
  isSupported(): Promise<boolean>;
  /** role "send" (with filePath) or "receive" (filePath = destination directory); starts peer discovery. */
  start(role: string, filePath: string): Promise<void>;
  connect(deviceAddress: string): Promise<void>;
  stop(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadP2P");
