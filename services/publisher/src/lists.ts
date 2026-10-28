import { readFileSync } from "node:fs";
import { buildEffectiveLists, KIND_APP_DATA, RelayPool, type EffectiveLists, type Event } from "@azaadawaaz/core";

/**
 * Load the official lists: owner lists first (to learn the moderators), then the moderators' lists, from the relays
 * plus any bootstrap events (bundled signed copies). Every event is verified by `buildEffectiveLists`.
 */
export async function loadLists(args: {
  pool: RelayPool;
  relays: string[];
  ownerPubkey: string;
  bootstrapFile?: string;
  timeoutMs?: number;
}): Promise<EffectiveLists> {
  const events: Event[] = [];
  if (args.bootstrapFile) {
    try {
      events.push(...(JSON.parse(readFileSync(args.bootstrapFile, "utf8")) as Event[]));
    } catch {
      // a missing or unreadable bootstrap file just means we rely on the relays
    }
  }
  const relays = [...new Set(args.relays)];
  events.push(...(await args.pool.query(relays, { kinds: [KIND_APP_DATA], authors: [args.ownerPubkey] }, args.timeoutMs)));
  const first = buildEffectiveLists(args.ownerPubkey, events);
  const official = [...new Set([...relays, ...first.relays.map((r) => r.url)])];
  const mods = [...first.activeModerators];
  if (mods.length) events.push(...(await args.pool.query(official, { kinds: [KIND_APP_DATA], authors: mods }, args.timeoutMs)));
  if (official.length > relays.length)
    events.push(...(await args.pool.query(official, { kinds: [KIND_APP_DATA], authors: [args.ownerPubkey] }, args.timeoutMs)));
  return buildEffectiveLists(args.ownerPubkey, events);
}

/** Relays to publish to: every relay on the official list plus the configured bootstrap relays. */
export function publishRelays(lists: EffectiveLists, bootstrap: string[]): string[] {
  return [...new Set([...lists.relays.map((r) => r.url), ...bootstrap])];
}
