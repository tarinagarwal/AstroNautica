import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/** Built-in Tor (Guardian Project tor-android) with Snowflake and obfs4 bridges (IPtProxy). */
export interface Spec extends TurboModule {
  /** {"bridges":"none"|"snowflake"|"obfs4","customBridges"?:string[]} → status JSON */
  start(configJson: string): Promise<string>;
  stop(): Promise<void>;
  /** {"state":"off"|"starting"|"on"|"stopping"|"error","socksPort":number,"bootstrap":number,"bridges","error"?} */
  status(): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadTor");
