import type { FastifyInstance } from "fastify";
import { raiseAlert } from "../alerts.js";
import { storeAudit, verifyAuditEvent } from "../audit.js";
import { caller, type Ctx } from "../context.js";
import { withTx } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { auditBody, hex64, parse } from "../validation.js";

export function contributorRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get("/contributors", { preHandler: [ctx.authenticate, ctx.require("moderator")] }, async () => {
    const r = await ctx.pool.query<{ pubkey: string; redeemed_at: Date; revoked_at: Date | null }>(
      "SELECT pubkey, redeemed_at, revoked_at FROM contributors ORDER BY redeemed_at, pubkey",
    );
    const listRevoked = ctx.lists.current().revokedContributors;
    return r.rows.map((c) => ({
      pubkey: c.pubkey,
      redeemedAt: c.redeemed_at.toISOString(),
      revokedAt: c.revoked_at?.toISOString() ?? null,
      revokedOnList: listRevoked.has(c.pubkey),
    }));
  });

  app.post<{ Params: { pubkey: string } }>(
    "/contributors/:pubkey/revoke",
    { preHandler: [ctx.authenticate, ctx.require("owner", "moderator")] },
    async (req) => {
      const pubkey = parse(hex64, req.params.pubkey, "pubkey");
      const actor = caller(req);
      const { auditEvent } = parse(auditBody, req.body);
      const e = verifyAuditEvent(
        auditEvent,
        { actor, action: "revoke_contributor", target: { tag: "p", value: pubkey } },
        ctx.nowSec(),
      );
      const revokedAt = await withTx(ctx.pool, async (c) => {
        const r = await c.query<{ revoked_at: Date }>(
          "UPDATE contributors SET revoked_at = now() WHERE pubkey = $1 AND revoked_at IS NULL RETURNING revoked_at",
          [pubkey],
        );
        if (!r.rows[0]) {
          const exists = await c.query("SELECT 1 FROM contributors WHERE pubkey = $1", [pubkey]);
          if (exists.rowCount) throw conflict("already_revoked", "this contributor is already revoked");
          throw notFound("contributor");
        }
        await storeAudit(c, e, { action: "revoke_contributor" });
        await raiseAlert(c, "contributor_revoked", { contributor: pubkey, by: actor, auditEventId: e.id });
        return r.rows[0].revoked_at;
      });
      ctx.forwarder.forward(e);
      return { pubkey, revokedAt: revokedAt.toISOString() };
    },
  );
}
