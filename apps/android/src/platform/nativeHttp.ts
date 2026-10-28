import NativeAzaadNet from "../native/specs/NativeAzaadNet";
import { base64ToBytes, bytesToBase64, nextId, utf8 } from "../util/bytes";
import { HttpError, type DownloadRequest, type Http, type HttpRequest, type HttpResponse, type UploadRequest } from "./types";
import { onNativeEvent } from "./nativeEvents";

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
  url: string;
}

/** Native errors carry a code ("network", "timeout", "too-large", "aborted", "mismatch") in the rejection. */
function toHttpError(e: unknown): HttpError {
  const err = e as { code?: string; message?: string };
  const kind = (["network", "timeout", "too-large", "aborted", "mismatch"] as const).find((k) => k === err?.code);
  return new HttpError(err?.message ?? String(e), kind ?? "network");
}

function withAbort<T>(signal: AbortSignal | undefined, id: string, run: () => Promise<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(new HttpError("aborted", "aborted"));
  const onAbort = () => NativeAzaadNet.cancel(id);
  signal?.addEventListener("abort", onAbort);
  return run()
    .catch((e) => {
      throw toHttpError(e);
    })
    .finally(() => signal?.removeEventListener("abort", onAbort));
}

const parse = (json: string): HttpResponse => {
  const r = JSON.parse(json) as RawResponse;
  return { status: r.status, headers: r.headers ?? {}, body: r.bodyBase64 ? base64ToBytes(r.bodyBase64) : new Uint8Array(0), url: r.url };
};

/** HTTP through the app's OkHttp client (direct with DoH, or through Tor). */
export const nativeHttp: Http = {
  request(req: HttpRequest) {
    const id = nextId("http");
    const body = req.body === undefined ? undefined : typeof req.body === "string" ? utf8(req.body) : req.body;
    const payload = JSON.stringify({
      url: req.url,
      method: req.method ?? "GET",
      headers: req.headers ?? {},
      bodyBase64: body ? bytesToBase64(body) : undefined,
      timeoutMs: req.timeoutMs ?? 30_000,
      maxBytes: req.maxBytes ?? 50 * 1024 * 1024,
    });
    return withAbort(req.signal, id, async () => parse(await NativeAzaadNet.request(id, payload)));
  },

  download(req: DownloadRequest) {
    const id = nextId("dl");
    const off = req.onProgress
      ? onNativeEvent<{ id: string; bytes: number; total: number }>("azaadNetProgress", (e) => {
          if (e.id === id) req.onProgress!(e.bytes, e.total);
        })
      : undefined;
    const payload = JSON.stringify({
      url: req.url,
      dest: req.dest,
      headers: req.headers ?? {},
      sha256: req.sha256,
      maxBytes: req.maxBytes ?? 4 * 1024 * 1024 * 1024,
      timeoutMs: req.timeoutMs ?? 60_000,
    });
    return withAbort(req.signal, id, async () => JSON.parse(await NativeAzaadNet.download(id, payload))).finally(
      () => off?.(),
    );
  },

  upload(req: UploadRequest) {
    const id = nextId("up");
    const payload = JSON.stringify({ url: req.url, method: req.method, headers: req.headers, filePath: req.filePath });
    return withAbort(req.signal, id, async () => parse(await NativeAzaadNet.upload(id, payload)));
  },
};
