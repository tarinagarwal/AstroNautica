/**
 * Invite redemption (spec §3.1). Links come as `azaadawaaz://invite/<code>`, `https://<any door>/#/invite/<code>`,
 * `…#invite=<code>` or the bare code, where <code> is core `encodeInvite(event)`. The owner's signature and expiry are
 * checked on the device against the pinned owner key before anything is sent.
 */
import { createRedemption, decodeInvite, verifyInvite, type Event, type InviteContent } from "@azaadawaaz/core";

/** Extract the encoded invite from any supported link form; undefined when the text holds no invite. */
export function extractInviteCode(text: string): string | undefined {
  const s = text.trim();
  const patterns = [
    /^azaadawaaz:\/\/invite\/([A-Za-z0-9_-]+)/,
    /#\/invite\/([A-Za-z0-9_-]+)/,
    /[#&?]invite=([A-Za-z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return /^[A-Za-z0-9_-]{40,}$/.test(s) ? s : undefined;
}

export type ParsedInvite = { ok: true; event: Event; content: InviteContent } | { ok: false; error: string };

export function parseInvite(text: string, ownerPubkey: string, now = Math.floor(Date.now() / 1000)): ParsedInvite {
  const code = extractInviteCode(text);
  if (!code) return { ok: false, error: "not an invite link" };
  let event: Event;
  try {
    event = decodeInvite(code);
  } catch {
    return { ok: false, error: "malformed invite" };
  }
  const check = verifyInvite(event, ownerPubkey, now);
  return check.ok ? { ok: true, event, content: check.content } : { ok: false, error: check.error };
}

/** The contributor-signed redemption to send to POST /invites/redeem. */
export function redemptionFor(invite: Event, contributorSecretKey: Uint8Array): Event {
  return createRedemption(invite, contributorSecretKey);
}
