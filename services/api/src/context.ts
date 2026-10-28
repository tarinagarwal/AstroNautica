import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditForwarder } from "./audit.js";
import type { Role } from "./auth.js";
import type { Config } from "./config.js";
import type { Pool } from "./db.js";
import type { ListsService } from "./lists.js";
import type { StagingStore } from "./staging.js";

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Everything route handlers need. */
export interface Ctx {
  config: Config;
  pool: Pool;
  lists: ListsService;
  staging: StagingStore;
  forwarder: AuditForwarder;
  /** Milliseconds since the epoch (injectable for tests). */
  now: () => number;
  nowSec: () => number;
  authenticate: Hook;
  require: (...roles: Role[]) => Hook;
  /** Max media items per submission (MAX_BLOCKS blocks of at most 20 images each). */
  maxMedia: number;
}

/** The authenticated caller's pubkey (routes using this always run `authenticate` first). */
export function caller(req: FastifyRequest): string {
  return req.auth!.pubkey;
}
