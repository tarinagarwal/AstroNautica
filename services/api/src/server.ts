/**
 * The AzaadAwaaz API (services/api): invites, NIP-98 auth, the encrypted staging store, the moderation queue and the
 * audit log. `buildServer` wires everything from injected dependencies so tests can run it with `fastify.inject`.
 */
import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { AuditForwarder } from "./audit.js";
import { ReplayCache, makeAuthenticate, makeRequire } from "./auth.js";
import type { Config } from "./config.js";
import type { Ctx } from "./context.js";
import type { Pool } from "./db.js";
import { HttpError } from "./errors.js";
import type { ListsService } from "./lists.js";
import { contributorRoutes } from "./routes/contributors.js";
import { mediaRoutes } from "./routes/media.js";
import { moderationRoutes } from "./routes/moderation.js";
import { ownerRoutes } from "./routes/owner.js";
import { publicRoutes } from "./routes/public.js";
import { submissionRoutes } from "./routes/submissions.js";
import { MAX_CHUNK_CIPHERTEXT, StagingStore } from "./staging.js";

export interface ServerDeps {
  config: Config;
  pool: Pool;
  lists: ListsService;
  forwarder?: AuditForwarder;
  /** Logging: `false` disables it; a stream captures it (tests). Remote addresses and headers are never logged. */
  logger?: false | { stream?: { write(msg: string): void }; level?: string };
  now?: () => number;
}

/** Log serializers: only the method, the route pattern (no ids or query) and the status code. */
export const logSerializers = {
  req: (req: { method?: string; routeOptions?: { url?: string } }) => ({
    method: req.method,
    route: req.routeOptions?.url ?? "unmatched",
  }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-dns-prefetch-control": "off",
  "x-permitted-cross-domain-policies": "none",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cache-control": "no-store",
};

function errorCode(err: FastifyError): string {
  switch (err.code) {
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return "payload_too_large";
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return "unsupported_media_type";
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return "invalid_body";
    default:
      return err.statusCode === 400 ? "invalid_json" : "bad_request";
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const now = deps.now ?? Date.now;

  const loggerOpts: FastifyServerOptions["logger"] =
    deps.logger === false
      ? false
      : {
          level: deps.logger?.level ?? config.logLevel,
          serializers: logSerializers,
          ...(deps.logger?.stream ? { stream: deps.logger.stream } : {}),
        };

  const app = Fastify({
    logger: loggerOpts,
    trustProxy: false,
    bodyLimit: config.maxJsonBytes,
    requestIdHeader: false,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 128 },
  });

  app.decorateRequest("auth", null);
  app.decorateRequest("rawBody", null);

  // Body parsers keep the raw bytes: the NIP-98 payload tag is the SHA-256 of exactly what was sent.
  app.removeAllContentTypeParsers();
  const jsonParse = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, undefined);
    jsonParse(req, buf.toString("utf8"), done);
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_CHUNK_CIPHERTEXT },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      done(null, body);
    },
  );

  const https = config.publicUrls.some((u) => u.startsWith("https://"));
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (https) reply.header("strict-transport-security", "max-age=63072000; includeSubDomains");
    return payload;
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin !== undefined && config.allowedOrigins.includes(origin)),
    methods: ["GET", "POST", "PUT"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
    maxAge: 600,
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: errorCode(err), message: err.message });
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "internal", message: "internal server error" });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found", message: "no such endpoint" }));

  const replay = new ReplayCache();
  const authDeps = { publicUrls: config.publicUrls, replay, lists: deps.lists, pool: deps.pool, now };
  const ctx: Ctx = {
    config,
    pool: deps.pool,
    lists: deps.lists,
    staging: new StagingStore(config.stagingDir),
    forwarder: deps.forwarder ?? { forward: () => {} },
    now,
    nowSec: () => Math.floor(now() / 1000),
    authenticate: makeAuthenticate({ ...authDeps, basePath: config.basePath }),
    require: makeRequire(authDeps),
    maxMedia: config.maxBlocks * 20,
  };

  await app.register(
    async (api) => {
      publicRoutes(api, ctx);
      contributorRoutes(api, ctx);
      submissionRoutes(api, ctx);
      mediaRoutes(api, ctx);
      moderationRoutes(api, ctx);
      ownerRoutes(api, ctx);
    },
    { prefix: config.basePath },
  );

  return app;
}
