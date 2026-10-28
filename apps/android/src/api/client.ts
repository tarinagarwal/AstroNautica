/**
 * Client for services/api (docs/architecture.md "HTTP API"). Authenticated calls carry a NIP-98 header whose `u` tag
 * is the full request URL exactly as sent and whose payload hash covers the exact body bytes. All requests go through
 * the app's network layer (Tor/DoH).
 */
import type { Approval } from "@azaadawaaz/schema";
import type { Event } from "nostr-tools/pure";
import type { Http, HttpResponse } from "../platform/types";
import { utf8 } from "../util/bytes";
import type { Signer } from "./nip98";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiConfig {
  ownerPubkey: string;
  ownerX25519: string | null;
  publisher: { pubkey: string; x25519: string | null } | null;
  moderators: { pubkey: string; x25519: string }[];
  relays: { url: string; operator: string }[];
  gateways: unknown[];
  limits: Record<string, number>;
}

export type SubmissionState =
  | "draft"
  | "submitted"
  | "in_review"
  | "changes_requested"
  | "rejected"
  | "approved"
  | "publishing"
  | "published"
  | "unlisted";

export interface MediaMeta {
  sha256: string;
  size: number;
  mime: string;
  kind: "image" | "video";
  chunks: number;
  complete?: boolean;
}

export interface Feedback {
  at: string;
  moderator: string;
  kind: "reject" | "changes";
  nip44: string;
}

export interface MySubmission {
  id: string;
  storyId: string;
  version: number;
  state: SubmissionState;
  feedback: Feedback[];
  createdAt: string;
  updatedAt: string;
  manifestCid: string | null;
  publishedAt: string | null;
}

export interface SubmissionDetail {
  id: string;
  storyId: string;
  version: number;
  supersedes: string | null;
  contributor: string;
  state: SubmissionState;
  bodyCiphertext: string;
  wrappedKey?: string | null;
  media: MediaMeta[];
  claimBy?: string | null;
  claimUntil?: string | null;
  feedback?: Feedback[];
  approval?: Approval | null;
  manifestCid?: string | null;
  createdAt?: string;
  submittedAt?: string | null;
}

export interface QueueItem {
  id: string;
  storyId: string;
  version: number;
  supersedes?: string | null;
  state: SubmissionState;
  contributor: string;
  claimBy?: string | null;
  claimUntil?: string | null;
  submittedAt?: string | null;
  media?: { count: number; totalBytes: number };
  wrappedForMe?: boolean;
}

export interface SubmissionInput {
  storyId: string;
  version: number;
  supersedes: string | null;
  bodyCiphertext: string;
  wrappedKeys: Record<string, string>;
  media: { sha256: string; size: number; mime: string; kind: "image" | "video"; chunks: number }[];
}

export interface MediaStatus {
  received: number[];
  header?: boolean;
  chunks?: number;
  complete: boolean;
}

export interface JobStatus {
  submissionId: string;
  state: string;
  steps: Record<string, { done: boolean; error?: string; attempts?: number; at?: string }>;
  attempts: number;
  [k: string]: unknown;
}

function decodeJson<T>(res: HttpResponse): T {
  const text = new TextDecoder().decode(res.body);
  return (text ? JSON.parse(text) : undefined) as T;
}

export class Api {
  constructor(
    readonly baseUrl: string,
    private readonly http: Http,
    private readonly signer?: Signer,
  ) {}

  withSigner(signer: Signer): Api {
    return new Api(this.baseUrl, this.http, signer);
  }

  url(path: string): string {
    return this.baseUrl.replace(/\/+$/, "") + path;
  }

  private async send(
    method: string,
    path: string,
    opts: { json?: unknown; raw?: Uint8Array; auth?: boolean } = {},
  ): Promise<HttpResponse> {
    if (!this.baseUrl) throw new ApiError(0, "no_api", "no API configured");
    const url = this.url(path);
    const headers: Record<string, string> = {};
    let body: Uint8Array | undefined;
    if (opts.json !== undefined) {
      body = utf8(JSON.stringify(opts.json));
      headers["content-type"] = "application/json";
    } else if (opts.raw) {
      body = opts.raw;
      headers["content-type"] = "application/octet-stream";
    }
    if (opts.auth !== false) {
      if (!this.signer) throw new ApiError(401, "no_key", "no key loaded");
      headers.authorization = this.signer.authHeader(url, method, body);
    }
    let res: HttpResponse;
    try {
      res = await this.http.request({ url, method, headers, body, timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 });
    } catch (e) {
      throw new ApiError(0, "network", e instanceof Error ? e.message : String(e));
    }
    return this.check(res);
  }

  private check(res: HttpResponse): HttpResponse {
    if (res.status >= 200 && res.status < 300) return res;
    let code = "http_" + res.status;
    let message = `HTTP ${res.status}`;
    try {
      const j = decodeJson<{ error?: string; message?: string }>(res);
      code = j?.error ?? code;
      message = j?.message ?? message;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, code, message);
  }

  private async json<T>(method: string, path: string, opts?: { json?: unknown; auth?: boolean }): Promise<T> {
    return decodeJson<T>(await this.send(method, path, opts));
  }

  // ---- public ----
  health = () => this.json<{ ok: boolean }>("GET", "/health", { auth: false });
  config = () => this.json<ApiConfig>("GET", "/config", { auth: false });
  redeemInvite = (redemption: Event) =>
    this.json<{ contributor: string }>("POST", "/invites/redeem", { json: { redemption }, auth: false });

  // ---- contributor ----
  createSubmission = (s: SubmissionInput) => this.json<{ id: string }>("POST", "/submissions", { json: s });
  updateSubmission = (id: string, s: SubmissionInput) =>
    this.json<{ id: string; state: SubmissionState }>("PUT", `/submissions/${id}`, { json: s });
  putHeader = async (id: string, sha: string, header: Uint8Array) => {
    await this.send("PUT", `/submissions/${id}/media/${sha}/header`, { raw: header });
  };
  /** Upload a chunk straight from an encrypted chunk file (its SHA-256 is known from the native encryptor). */
  putChunkFile = async (id: string, sha: string, n: number, filePath: string, chunkSha256: string) => {
    if (!this.signer) throw new ApiError(401, "no_key", "no key loaded");
    const url = this.url(`/submissions/${id}/media/${sha}/chunks/${n}`);
    let res: HttpResponse;
    try {
      res = await this.http.upload({
        url,
        method: "PUT",
        filePath,
        headers: {
          "content-type": "application/octet-stream",
          authorization: this.signer.authHeaderForHash(url, "PUT", chunkSha256),
        },
      });
    } catch (e) {
      throw new ApiError(0, "network", e instanceof Error ? e.message : String(e));
    }
    this.check(res);
  };
  mediaStatus = (id: string, sha: string) => this.json<MediaStatus>("GET", `/submissions/${id}/media/${sha}/status`);
  completeMedia = (id: string, sha: string) =>
    this.json<{ complete: boolean }>("POST", `/submissions/${id}/media/${sha}/complete`, { json: {} });
  submit = (id: string) => this.json<{ id: string; state: SubmissionState }>("POST", `/submissions/${id}/submit`, { json: {} });
  mySubmissions = () => this.json<MySubmission[]>("GET", "/me/submissions");

  // ---- moderator ----
  submission = (id: string, x25519?: string) =>
    this.json<SubmissionDetail>("GET", `/submissions/${id}` + (x25519 ? `?x25519=${encodeURIComponent(x25519)}` : ""));
  mediaHeader = async (id: string, sha: string) => (await this.send("GET", `/submissions/${id}/media/${sha}/header`)).body;
  mediaChunk = async (id: string, sha: string, n: number) =>
    (await this.send("GET", `/submissions/${id}/media/${sha}/chunks/${n}`)).body;
  queue = () => this.json<QueueItem[]>("GET", "/queue");
  claim = (id: string, auditEvent?: Event) =>
    this.json<{ claimUntil: string }>("POST", `/submissions/${id}/claim`, { json: auditEvent ? { auditEvent } : {} });
  approve = (
    id: string,
    body: { approval: Approval; approvalBodySha256: string; publisherWrappedKey: string; auditEvent: Event },
  ) => this.json<{ state: SubmissionState }>("POST", `/submissions/${id}/approve`, { json: body });
  reject = (id: string, body: { feedback: string; auditEvent: Event }) =>
    this.json<{ state: SubmissionState }>("POST", `/submissions/${id}/reject`, { json: body });
  requestChanges = (id: string, body: { feedback: string; auditEvent: Event }) =>
    this.json<{ state: SubmissionState }>("POST", `/submissions/${id}/request-changes`, { json: body });
  addKeys = (id: string, wrappedKeys: Record<string, string>) =>
    this.json<{ added: string[] }>("POST", `/submissions/${id}/keys`, { json: { wrappedKeys } });
  rewrapNeeded = () =>
    this.json<{ id: string; missing: string[]; wrappedKey: string | null }[]>("GET", "/rewrap-needed");
  unlist = (storyId: string, auditEvent: Event) =>
    this.json<{ unlisted: number }>("POST", "/moderation/unlist", { json: { storyId, auditEvent } });
  audit = (auditEvent: Event) => this.json<unknown>("POST", "/moderation/audit", { json: { auditEvent } });
  jobs = () => this.json<JobStatus[]>("GET", "/jobs");
  contributors = () =>
    this.json<{ pubkey: string; redeemedAt: string; revokedAt: string | null }[]>("GET", "/contributors");
}
