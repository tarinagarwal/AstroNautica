import type { EffectiveLists } from "@core/lists.js";

export class RecipientsError extends Error {
  constructor() {
    super("the signed lists have no encryption keys for the owner or moderators");
    this.name = "RecipientsError";
  }
}

/** X25519 keys a submission must be wrapped for: the owner's and every active moderator's, from signed lists. */
export function stagingRecipients(lists: EffectiveLists, now = Math.floor(Date.now() / 1000)): string[] {
  const owner = lists.serviceKeys.find(
    (k) =>
      k.role === "owner" &&
      k.pubkey === lists.owner &&
      k.x25519 &&
      k.from <= now &&
      (k.until === undefined || k.until > now),
  )?.x25519;
  const mods = lists.moderators.filter((m) => lists.activeModerators.has(m.pubkey)).map((m) => m.x25519);
  if (!owner || mods.length === 0) throw new RecipientsError();
  return [...new Set([owner, ...mods])];
}
