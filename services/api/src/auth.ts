/**
 * NIP-98 HTTP auth (docs/architecture.md, "HTTP API"): `Authorization: Nostr <base64 event>` with `u` = the full
 * request URL as the client used it (one of PUBLIC_URL + path + query), the method, and the SHA-256 of the raw body.
 * Accepted event ids are stored in Postgres (`auth_replay`) until the event's created_at + AUTH_WINDOW_SEC + 1 s, so
 * a captured header can't be replayed, also not after a restart or against another API replica.
 */
import { verifyAuthHeader } from "@azaadawaaz/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, Queryable } from "./db.js";
import { forbidden, unauthorized } from "./errors.js";
import type { ListsService } from "./lists.js";

/** NIP-98 events older or newer than this (seconds) are rejected. */
export const AUTH_WINDOW_SEC = 60;

/** Remembers accepted auth event ids until they would be rejected as expired anyway. */
export interface ReplayStore {
  /** Returns false if `id` is already remembered and unexpired; otherwise remembers it until `expiresAtSec`. */
  remember(id: string, expiresAtSec: number, nowMs: number): Promise<boolean>;
}

/** The replay store in Postgres, shared by every API process; `runCleanup` purges expired rows. */
export class PgReplayStore implements ReplayStore {
  constructor(private readonly db: Queryable) {}

  async remember(id: string, expiresAtSec: number, nowMs: number): Promise<boolean> {
    // A conflicting row only blocks while it is unexpired (an expired one that cleanup has not purged yet is reused).
    const r = await this.db.query(
      `INSERT INTO auth_replay (event_id, expires_at) VALUES ($1, to_timestamp($2))
       ON CONFLICT (event_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
       WHERE auth_replay.expires_at <= to_timestamp($3)`,
      [id, expiresAtSec, nowMs / 1000],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * Decode the header's event and check every field has the NIP-01 shape before any verification runs, so a malformed
 * event (non-array tags, non-string tag values, a string created_at, …) is a 401 and never reaches code that could
 * throw on it. Returns null when the header is not a well-formed event.
 */
export function parseAuthEvent(header: string): { id: string; created_at: number } | null {
  let e: unknown;
  try {
    e = JSON.parse(atob(header.slice(6).trim()));
  } catch {
    return null;
  }
  if (typeof e !== "object" || e === null || Array.isArray(e)) return null;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== "string" || !HEX64.test(o.id)) return null;
  if (typeof o.pubkey !== "string" || !HEX64.test(o.pubkey)) return null;
  if (typeof o.sig !== "string" || !HEX128.test(o.sig)) return null;
  if (!Number.isSafeInteger(o.kind) || !Number.isSafeInteger(o.created_at) || (o.created_at as number) < 0) return null;
  if (typeof o.content !== "string") return null;
  if (!Array.isArray(o.tags) || o.tags.length > 100) return null;
  for (const t of o.tags) {
    if (!Array.isArray(t) || t.length === 0 || t.some((v) => typeof v !== "string")) return null;
  }
  return { id: o.id, created_at: o.created_at as number };
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
  replay: ReplayStore;
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
    if (typeof header !== "string" || !header.startsWith("Nostr ")) throw unauthorized("missing Nostr authorization");
    const parsed = parseAuthEvent(header);
    if (!parsed) throw unauthorized("malformed authorization");
    const body = req.rawBody && req.rawBody.length > 0 ? new Uint8Array(req.rawBody) : undefined;
    const nowSec = Math.floor(deps.now() / 1000);
    let lastError = "url mismatch";
    for (const url of candidateUrls(deps.publicUrls, deps.basePath, req.url)) {
      let r: ReturnType<typeof verifyAuthHeader>;
      try {
        r = verifyAuthHeader(header, url, req.method, body, nowSec, AUTH_WINDOW_SEC);
      } catch {
        // Defence in depth: whatever the verifier chokes on is the client's malformed header, never a 500.
        throw unauthorized("malformed authorization");
      }
      if (r.ok) {
        if (r.eventId !== parsed.id) throw unauthorized("malformed authorization");
        const expiresAt = parsed.created_at + AUTH_WINDOW_SEC + 1;
        if (!(await deps.replay.remember(r.eventId, expiresAt, deps.now())))
          throw unauthorized("authorization replayed");
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
