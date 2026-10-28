import type { Queryable } from "./db.js";

export type AlertKind = "unlist" | "unlist_rate_limited" | "contributor_revoked" | "publish_failed";

/** Raise an owner alert (spec §5.4: the owner is alerted on every unlisting). */
export async function raiseAlert(db: Queryable, kind: AlertKind, detail: Record<string, unknown>): Promise<void> {
  await db.query("INSERT INTO owner_alerts (kind, detail) VALUES ($1, $2::jsonb)", [kind, JSON.stringify(detail)]);
}
