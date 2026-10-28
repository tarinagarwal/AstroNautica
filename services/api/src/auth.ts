/**
 * NIP-98 HTTP auth (docs/architecture.md, "HTTP API"): `Authorization: Nostr <base64 event>` with `u` = the full
 * request URL as the client used it (one of PUBLIC_URL + path + query), the method, and the SHA-256 of the raw body.
 * Event ids are remembered for 120 s so a captured header can't be replayed.
 */
import { verifyAuthHeader } from "@azaadawaaz/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "./db.js";
import { forbidden, unauthorized } from "./errors.js";
import type { ListsService } from "./lists.js";

export const REPLAY_WINDOW_SEC = 120;
/** NIP-98 events older or newer than this are rejected; must stay below the replay window. */
export const AUTH_WINDOW_SEC = 60;

export class ReplayCache {
  private readonly seen = new Map<string, number>();
  private lastSweep = 0;

  constructor(private readonly ttlMs = REPLAY_WINDOW_SEC * 1000) {}

  /** Returns false if `id` was already seen within the window; otherwise remembers it. */
  remember(id: string, nowMs = Date.now()): boolean {
    if (nowMs - this.lastSweep > 10_000) {
      for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
      this.lastSweep = nowMs;
    }
    const exp = this.seen.get(id);
    if (exp !== undefined && exp > nowMs) return false;
    this.seen.set(id, nowMs + this.ttlMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface AuthInfo {
  pubkey: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthInfo | null;
    rawBody: Buffer | null;
  }
}

export interface AuthDeps {
  publicUrls: string[];
  replay: ReplayCache;
  lists: ListsService;
  pool: Pool;
  now: () => number;
}

/** Build the URL candidates the client may have signed: each public base URL + path + query. */
function candidateUrls(publicUrls: string[], basePath: string, rawUrl: string): string[] {
  // rawUrl is the path + query as received (it already includes basePath when served under a prefix).
  const path = basePath && rawUrl.startsWith(basePath) ? rawUrl.slice(basePath.length) : rawUrl;
  return publicUrls.map((b) => b + path);
}

export function makeAuthenticate(deps: AuthDeps & { basePath: string }) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    if (typeof header !== "string") throw unauthorized("missing Nostr authorization");
    const body = req.rawBody && req.rawBody.length > 0 ? new Uint8Array(req.rawBody) : undefined;
    const nowSec = Math.floor(deps.now() / 1000);
    let lastError = "url mismatch";
    for (const url of candidateUrls(deps.publicUrls, deps.basePath, req.url)) {
      const r = verifyAuthHeader(header, url, req.method, body, nowSec, AUTH_WINDOW_SEC);
      if (r.ok) {
        if (!deps.replay.remember(r.eventId, deps.now())) throw unauthorized("authorization replayed");
        req.auth = { pubkey: r.pubkey };
        return;
      }
      lastError = r.error;
      if (r.error !== "url mismatch") break;
    }
    throw unauthorized(lastError);
  };
}

export interface ContributorRow {
  pubkey: string;
  revoked_at: Date | null;
}

export async function getContributor(pool: Pool, pubkey: string): Promise<ContributorRow | undefined> {
  const r = await pool.query<ContributorRow>("SELECT pubkey, revoked_at FROM contributors WHERE pubkey = $1", [pubkey]);
  return r.rows[0];
}

/** Revoked in the database or on any moderator's signed revoked-contributors list. */
export function isRevoked(lists: ListsService, c: ContributorRow): boolean {
  return c.revoked_at !== null || lists.current().revokedContributors.has(c.pubkey);
}

export type Role = "owner" | "moderator" | "contributor" | "known-contributor";

/**
 * preHandler requiring the authenticated key to have one of the roles:
 * - owner: the pinned owner key;
 * - moderator: an active moderator or the owner;
 * - contributor: redeemed an invite and not revoked;
 * - known-contributor: redeemed an invite (revoked contributors can still read their own submissions).
 */
export function makeRequire(deps: AuthDeps) {
  return (...roles: Role[]) =>
    async function requireRole(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const pk = req.auth?.pubkey;
      if (!pk) throw unauthorized("missing Nostr authorization");
      if (roles.includes("owner") && deps.lists.isOwner(pk)) return;
      if (roles.includes("moderator") && deps.lists.isModerator(pk)) return;
      if (roles.includes("contributor") || roles.includes("known-contributor")) {
        const c = await getContributor(deps.pool, pk);
        if (c && (roles.includes("known-contributor") || !isRevoked(deps.lists, c))) return;
        if (c && roles.includes("contributor")) throw forbidden("this contributor has been revoked");
      }
      throw forbidden(`requires role: ${roles.filter((r) => r !== "known-contributor").join(" or ")}`);
    };
}
