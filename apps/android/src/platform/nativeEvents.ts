import { NativeEventEmitter, type EventSubscription } from "react-native";
import NativeAzaadNet from "../native/specs/NativeAzaadNet";
import NativeAzaadFiles from "../native/specs/NativeAzaadFiles";
import NativeAzaadTor from "../native/specs/NativeAzaadTor";
import NativeAzaadP2P from "../native/specs/NativeAzaadP2P";

/** One emitter per native module that sends events (Kotlin: ReactContext.emitDeviceEvent). */
const emitters = {
  net: new NativeEventEmitter(NativeAzaadNet as never),
  files: new NativeEventEmitter(NativeAzaadFiles as never),
  tor: new NativeEventEmitter(NativeAzaadTor as never),
  p2p: new NativeEventEmitter(NativeAzaadP2P as never),
};

export type NativeEventName = "azaadWs" | "azaadNetProgress" | "azaadIntent" | "azaadTor" | "azaadP2p";

const source: Record<NativeEventName, keyof typeof emitters> = {
  azaadWs: "net",
  azaadNetProgress: "net",
  azaadIntent: "files",
  azaadTor: "tor",
  azaadP2p: "p2p",
};

export function onNativeEvent<T = Record<string, unknown>>(name: NativeEventName, fn: (e: T) => void): () => void {
  const sub: EventSubscription = emitters[source[name]].addListener(name, (e: unknown) => fn(e as T));
  return () => sub.remove();
}
