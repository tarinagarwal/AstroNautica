/**
 * Platform interfaces. Everything above this layer is plain TypeScript, tested in Node with the implementations in
 * src/test/nodePlatform.ts; on the phone the implementations in ./native*.ts call the app's Kotlin modules.
 */

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs?: number;
  /** Refuse responses larger than this (default 50 MiB). */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Final URL after redirects. */
  url: string;
}

export interface DownloadRequest {
  url: string;
  dest: string;
  headers?: Record<string, string>;
  /** When set, the file is deleted and the promise rejects unless the bytes hash to this. */
  sha256?: string;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}

export interface UploadRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  filePath: string;
  signal?: AbortSignal;
}

export interface Http {
  request(req: HttpRequest): Promise<HttpResponse>;
  download(req: DownloadRequest): Promise<{ sha256: string; size: number }>;
  upload(req: UploadRequest): Promise<HttpResponse>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "too-large" | "aborted" | "mismatch",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FileStat {
  exists: boolean;
  size: number;
  isDir: boolean;
  mtime: number;
}

export interface ZipEntry {
  name: string;
  size: number;
}

export interface FilePatch {
  offset: number;
  data: Uint8Array;
  /** When set, write this many zero bytes at `offset` instead of `data`. */
  zero?: number;
}

export interface FileSystem {
  readonly paths: { files: string; cache: string };
  writeBytes(path: string, data: Uint8Array, append?: boolean): Promise<void>;
  /** Reads `length` bytes from `offset` (to the end when length is omitted or negative). */
  readBytes(path: string, offset?: number, length?: number): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  /** Rejects when the file does not exist. */
  readText(path: string): Promise<string>;
  stat(path: string): Promise<FileStat>;
  remove(path: string): Promise<void>;
  mkdirs(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  sha256(path: string): Promise<string>;
  /** Copy `src` to `dest` with byte patches applied (and optionally truncated); src may equal dest. */
  patch(src: string, dest: string, patches: FilePatch[], truncate?: number): Promise<void>;
  zipDir(dir: string, out: string): Promise<void>;
  unzip(zip: string, destDir: string, limits: { maxBytes: number; maxEntries: number }): Promise<ZipEntry[]>;
}

export const joinPath = (...parts: string[]) =>
  parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");

export interface WebSocketLike {
  readonly readyState: number;
  readonly url: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string; message?: string }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketCtor {
  new (url: string): WebSocketLike;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}
