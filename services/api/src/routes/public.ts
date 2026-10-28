import { CHUNK_SIZE, verifyRedemption, type Event } from "@azaadawaaz/core";
import { sha256Hex } from "@azaadawaaz/schema";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.js";
import { isUniqueViolation, withTx } from "../db.js";
import { HttpError, badRequest, conflict } from "../errors.js";
import { inviteRevokeBody, parse, redeemBody } from "../validation.js";

/** Redemptions dated further in the future than this are rejected. */
const FUTURE_SKEW_SEC = 600;

export function publicRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { lists, config } = ctx;

  app.get("/health", async () => ({ ok: true }));

  app.get("/config", async () => {
    const l = lists.current();
    const publisher = lists.publisher();
    return {
      ownerPubkey: config.ownerPubkey,
      ownerX25519: lists.ownerX25519() ?? null,
      publisher: publisher ? { pubkey: publisher.pubkey, x25519: publisher.x25519 ?? null } : null,
      moderators: lists.activeModerators().map((m) => ({ pubkey: m.pubkey, x25519: m.x25519 })),
      relays: l.relays.length ? l.relays : config.relays.map((url) => ({ url, operator: "own" as const })),
      gateways: l.gateways,
      limits: {
        maxImageBytes: config.maxImageBytes,
        maxVideoBytes: config.maxVideoBytes,
        maxBlocks: config.maxBlocks,
        maxMediaItems: ctx.maxMedia,
        maxSubmissionBytes: config.maxSubmissionBytes,
        maxContributorStagingBytes: config.maxContributorStagingBytes,
        draftRetentionDays: config.draftRetentionDays,
        maxBodyChars: config.maxJsonBytes,
        chunkSize: CHUNK_SIZE,
        claimMinutes: config.claimMinutes,
        unlistPerHour: config.unlistPerHour,
        submissionsPerHour: config.submissionsPerHour,
      },
    };
  });

  app.post("/invites/redeem", async (req, reply) => {
    const { redemption } = parse(redeemBody, req.body);
    const now = ctx.nowSec();
    const r = verifyRedemption(redemption as unknown as Event, config.ownerPubkey, now);
    if (!r.ok) {
      if (r.error === "invite expired") throw badRequest("invite_expired", "this invite has expired");
      throw badRequest("invalid_invite", r.error);
    }
    if ((redemption as unknown as Event).created_at > now + FUTURE_SKEW_SEC)
      throw badRequest("invalid_invite", "redemption is dated in the future");
    const inviteId = r.invite.id;
    try {
      await withTx(ctx.pool, async (c) => {
        const revoked = await c.query("SELECT 1 FROM invites_revoked WHERE invite_id = $1", [inviteId]);
        if (revoked.rowCount) throw new HttpError(403, "invite_revoked", "this invite has been revoked");
        const used = await c.query("SELECT 1 FROM invites_used WHERE invite_id = $1 OR code_sha256 = $2", [
          inviteId,
          sha256Hex(r.content.code),
        ]);
        if (used.rowCount) throw conflict("invite_used", "this invite has already been used");
        const existing = await c.query("SELECT 1 FROM contributors WHERE pubkey = $1", [r.contributor]);
        if (existing.rowCount) throw conflict("already_contributor", "this key is already a contributor");
        await c.query("INSERT INTO contributors (pubkey, invite_id, redemption) VALUES ($1, $2, $3::jsonb)", [
          r.contributor,
          inviteId,
          JSON.stringify(redemption),
        ]);
        await c.query("INSERT INTO invites_used (invite_id, code_sha256, contributor) VALUES ($1, $2, $3)", [
          inviteId,
          sha256Hex(r.content.code),
          r.contributor,
        ]);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("invite_used", "this invite has already been used");
      throw e;
    }
    return reply.code(201).send({ contributor: r.contributor });
  });

  app.post("/invites/revoke", { preHandler: [ctx.authenticate, ctx.require("owner")] }, async (req) => {
    const { inviteId } = parse(inviteRevokeBody, req.body);
    await ctx.pool.query("INSERT INTO invites_revoked (invite_id) VALUES ($1) ON CONFLICT DO NOTHING", [inviteId]);
    return { inviteId, revoked: true };
  });
}
