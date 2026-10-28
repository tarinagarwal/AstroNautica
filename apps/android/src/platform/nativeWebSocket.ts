import NativeAzaadNet from "../native/specs/NativeAzaadNet";
import { nextId } from "../util/bytes";
import { onNativeEvent } from "./nativeEvents";
import type { WebSocketLike } from "./types";

interface WsEvent {
  id: string;
  type: "open" | "message" | "close" | "error";
  data?: string;
  code?: number;
  reason?: string;
}

const sockets = new Map<string, NativeWebSocket>();
let unsubscribe: (() => void) | undefined;

function ensureListener(): void {
  if (unsubscribe) return;
  unsubscribe = onNativeEvent<WsEvent>("azaadWs", (e) => sockets.get(e.id)?.dispatch(e));
}

/**
 * A browser-style WebSocket backed by the native OkHttp client, so relay connections use the same transport as
 * everything else (Tor's SOCKS port or DoH). Passed to nostr-tools as `websocketImplementation`.
 */
export class NativeWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; message?: string }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  private readonly id = nextId("ws");

  constructor(readonly url: string) {
    if (!/^wss?:\/\//i.test(url)) throw new SyntaxError(`invalid WebSocket URL: ${url}`);
    ensureListener();
    sockets.set(this.id, this);
    NativeAzaadNet.wsConnect(this.id, url);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    NativeAzaadNet.wsSend(this.id, data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    NativeAzaadNet.wsClose(this.id, code, reason);
  }

  /** @internal */
  dispatch(e: WsEvent): void {
    switch (e.type) {
      case "open":
        this.readyState = 1;
        this.onopen?.({});
        break;
      case "message":
        this.onmessage?.({ data: e.data ?? "" });
        break;
      case "error":
        this.readyState = 3;
        sockets.delete(this.id);
        this.onerror?.({ message: e.reason });
        this.onclose?.({ code: 1006, reason: e.reason ?? "", message: e.reason });
        break;
      case "close":
        this.readyState = 3;
        sockets.delete(this.id);
        this.onclose?.({ code: e.code ?? 1005, reason: e.reason ?? "" });
        break;
    }
  }
}
