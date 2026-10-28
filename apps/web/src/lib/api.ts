/**
 * Client for `services/api` (docs/architecture.md "HTTP API"). Authenticated calls carry a NIP-98 header whose `u`
 * tag is the full request URL exactly as sent, and whose payload hash covers the exact body bytes.
 */
import type { Event } from "nostr-tools/pure";
import type { Approval } from "@azaadawaaz/schema";
import type { Signer } from "./signer.js";

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
  ownerX25519: string;
  publisher: { pubkey: string; x25519: string };
  moderators: { pubkey: string; x25519: string }[];
  relays: string[];
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
  feedback: Feedback[] | null;
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
  feedback?: Feedback[] | null;
  createdAt?: string;
  submittedAt?: string | null;
}

export interface QueueItem {
  id: string;
  storyId: string;
  version: number;
  state: SubmissionState;
  contributor: string;
  claimBy?: string | null;
  claimUntil?: string | null;
  submittedAt?: string | null;
  createdAt?: string;
}

export interface SubmissionInput {
  storyId: string;
  version: number;
  supersedes: string | null;
  bodyCiphertext: string;
  wrappedKeys: Record<string, string>;
  media: { sha256: string; size: number; mime: string; kind: "image" | "video"; chunks: number }[];
}

export interface JobStatus {
  submissionId: string;
  state: string;
  steps: Record<string, { done: boolean; error?: string; attempts?: number; at?: string; result?: unknown }>;
  attempts: number;
  nextAttemptAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export interface AlertItem {
  id: number | string;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ContributorRow {
  pubkey: string;
  redeemedAt: string;
  revokedAt: string | null;
}

export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  submissionId?: string | null;
  event: Event;
  createdAt: string;
}

/** Accepts camelCase or snake_case field names from the API. */
function camel<T>(x: unknown): T {
  if (Array.isArray(x)) return x.map((v) => camel(v)) as T;
  if (x && typeof x === "object" && !isEvent(x)) {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>).map(([k, v]) => [
        k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
        k === "steps" || k === "detail" || k === "wrapped_keys" || k === "wrappedKeys" ? v : camel(v),
      ]),
    ) as T;
  }
  return x as T;
}

function isEvent(x: object): boolean {
  return "sig" in x && "pubkey" in x && "kind" in x;
}

export class Api {
  constructor(
    readonly baseUrl: string,
    private readonly signer?: Signer,
    private readonly fetchImpl: typeof fetch = (u, i) => globalThis.fetch(u, i),
  ) {}

  withSigner(signer: Signer): Api {
    return new Api(this.baseUrl, signer, this.fetchImpl);
  }

  url(path: string): string {
    return this.baseUrl.replace(/\/+$/, "") + path;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { json?: unknown; raw?: Uint8Array; auth?: boolean; binary?: boolean } = {},
  ): Promise<T> {
    if (!this.baseUrl) throw new ApiError(0, "no_api", "no API configured");
    const url = this.url(path);
    const headers: Record<string, string> = {};
    let body: string | Uint8Array | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["content-type"] = "application/json";
    } else if (opts.raw) {
      body = opts.raw;
      headers["content-type"] = "application/octet-stream";
    }
    if (opts.auth !== false) {
      if (!this.signer) throw new ApiError(401, "no_key", "log in first");
      headers.authorization = await this.signer.authHeader(url, method, body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: body as BodyInit | undefined });
    } catch (e) {
      throw new ApiError(0, "network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) {
      let code = "http_" + res.status;
      let message = res.statusText;
      try {
        const j = (await res.json()) as { error?: string; message?: string };
        code = j.error ?? code;
        message = j.message ?? message;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, code, message);
    }
    if (opts.binary) return new Uint8Array(await res.arrayBuffer()) as T;
    const text = await res.text();
    return text ? camel<T>(JSON.parse(text)) : (undefined as T);
  }

  // ---- public ----
  health = () => this.request<{ ok: boolean }>("GET", "/health", { auth: false });
  config = async () => {
    const c = await this.request<ApiConfig>("GET", "/config", { auth: false });
    return c;
  };
  redeemInvite = (redemption: Event) =>
    this.request<{ contributor: string }>("POST", "/invites/redeem", { json: { redemption }, auth: false });

  // ---- contributor ----
  createSubmission = (s: SubmissionInput) => this.request<{ id: string }>("POST", "/submissions", { json: s });
  updateSubmission = (id: string, s: SubmissionInput) =>
    this.request<unknown>("PUT", `/submissions/${id}`, { json: s });
  putHeader = (id: string, sha: string, header: Uint8Array) =>
    this.request<unknown>("PUT", `/submissions/${id}/media/${sha}/header`, { raw: header });
  putChunk = (id: string, sha: string, n: number, bytes: Uint8Array) =>
    this.request<unknown>("PUT", `/submissions/${id}/media/${sha}/chunks/${n}`, { raw: bytes });
  mediaStatus = (id: string, sha: string) =>
    this.request<{ received: number[]; complete: boolean }>("GET", `/submissions/${id}/media/${sha}/status`);
  completeMedia = (id: string, sha: string) =>
    this.request<unknown>("POST", `/submissions/${id}/media/${sha}/complete`, { json: {} });
  submit = (id: string) => this.request<unknown>("POST", `/submissions/${id}/submit`, { json: {} });
  mySubmissions = () => this.request<MySubmission[]>("GET", "/me/submissions");

  // ---- moderator ----
  submission = (id: string, x25519?: string) =>
    this.request<SubmissionDetail>(
      "GET",
      `/submissions/${id}` + (x25519 ? `?x25519=${encodeURIComponent(x25519)}` : ""),
    );
  mediaHeader = (id: string, sha: string) =>
    this.request<Uint8Array>("GET", `/submissions/${id}/media/${sha}/header`, { binary: true });
  mediaChunk = (id: string, sha: string, n: number) =>
    this.request<Uint8Array>("GET", `/submissions/${id}/media/${sha}/chunks/${n}`, { binary: true });
  queue = () => this.request<QueueItem[]>("GET", "/queue");
  claim = (id: string) => this.request<unknown>("POST", `/submissions/${id}/claim`, { json: {} });
  approve = (
    id: string,
    body: { approval: Approval; approvalBodySha256: string; publisherWrappedKey: string; auditEvent: Event },
  ) => this.request<unknown>("POST", `/submissions/${id}/approve`, { json: body });
  reject = (id: string, body: { feedback: string; auditEvent: Event }) =>
    this.request<unknown>("POST", `/submissions/${id}/reject`, { json: body });
  requestChanges = (id: string, body: { feedback: string; auditEvent: Event }) =>
    this.request<unknown>("POST", `/submissions/${id}/request-changes`, { json: body });
  addKeys = (id: string, wrappedKeys: Record<string, string>) =>
    this.request<unknown>("POST", `/submissions/${id}/keys`, { json: { wrappedKeys } });
  rewrapNeeded = () => this.request<{ id: string; missing?: string[] }[]>("GET", "/rewrap-needed");
  unlist = (storyId: string, auditEvent: Event) =>
    this.request<unknown>("POST", "/moderation/unlist", { json: { storyId, auditEvent } });
  audit = (auditEvent: Event) => this.request<unknown>("POST", "/moderation/audit", { json: { auditEvent } });
  contributors = () => this.request<ContributorRow[]>("GET", "/contributors");
  revokeContributor = (pubkey: string, auditEvent: Event) =>
    this.request<unknown>("POST", `/contributors/${pubkey}/revoke`, { json: { auditEvent } });
  jobs = () => this.request<JobStatus[]>("GET", "/jobs");

  // ---- owner ----
  retryJob = (id: string) => this.request<unknown>("POST", `/jobs/${id}/retry`, { json: {} });
  auditLog = (before?: string) =>
    this.request<AuditRow[] | { items: AuditRow[]; next?: string }>(
      "GET",
      "/audit" + (before ? `?before=${encodeURIComponent(before)}` : ""),
    );
  alerts = () => this.request<AlertItem[]>("GET", "/owner/alerts");
  alertsSeen = (ids?: (number | string)[]) =>
    this.request<unknown>("POST", "/owner/alerts/seen", { json: ids ? { ids } : {} });
  revokeInvite = (inviteId: string) => this.request<unknown>("POST", "/invites/revoke", { json: { inviteId } });
}
