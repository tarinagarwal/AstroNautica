import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/**
 * All app networking (spec §8.2): one OkHttp client, either direct with DNS-over-HTTPS or through Tor's SOCKS port.
 * Requests, downloads, uploads and relay WebSockets all go through it. JSON strings keep the bridge surface small.
 */
export interface Spec extends TurboModule {
  /** {"mode":"direct"|"tor","socksPort"?:number,"doh":boolean} */
  configure(configJson: string): void;
  /** {"url","method","headers":{},"bodyBase64"?,"timeoutMs","maxBytes"} → {"status","headers","bodyBase64","url"} */
  request(requestId: string, requestJson: string): Promise<string>;
  cancel(requestId: string): void;
  /** {"url","dest","sha256"?,"maxBytes","timeoutMs"} → {"sha256","size"}; progress events "azaadNetProgress". */
  download(requestId: string, requestJson: string): Promise<string>;
  /** {"url","method","headers":{},"filePath"} → same shape as request. */
  upload(requestId: string, requestJson: string): Promise<string>;
  /** Events "azaadWs": {"id","type":"open"|"message"|"close"|"error","data"?,"code"?,"reason"?} */
  wsConnect(socketId: string, url: string): void;
  wsSend(socketId: string, text: string): void;
  wsClose(socketId: string, code: number, reason: string): void;
  /** IPFS gateways for the verified media provider (HLS playback): {"gateways":["https://…"]} */
  setMediaSources(sourcesJson: string): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadNet");
