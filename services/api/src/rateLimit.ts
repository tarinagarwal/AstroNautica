/** Per-key rate limiting in `rate_events` (no IP addresses, ever). */
import type { Client } from "./db.js";

/**
 * Inside a transaction: if `pubkey` performed `action` fewer than `limit` times in the last `windowSec`, record one
 * more and return true; otherwise return false. An advisory transaction lock serialises concurrent requests per key.
 */
export async function consumeRate(
  c: Client,
  pubkey: string,
  action: string,
  limit: number,
  windowSec = 3600,
): Promise<boolean> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rate|${action}|${pubkey}`]);
  const r = await c.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM rate_events WHERE pubkey = $1 AND action = $2 AND at > now() - make_interval(secs => $3)",
    [pubkey, action, windowSec],
  );
  if ((r.rows[0]?.n ?? 0) >= limit) return false;
  await c.query("INSERT INTO rate_events (pubkey, action) VALUES ($1, $2)", [pubkey, action]);
  return true;
}
