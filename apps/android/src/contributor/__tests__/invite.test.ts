import { createInvite, verifyRedemption } from "@azaadawaaz/core";
import { contributor, modA, owner } from "../../test/fixtures";
import { extractInviteCode, parseInvite, redemptionFor } from "../invite";
import { decryptFeedback, encryptFeedback, canEdit } from "../submissions";

describe("invites", () => {
  const { link, event } = createInvite(owner.secretKey, {
    note: "welcome",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

  it("accepts every link form", () => {
    for (const text of [
      `azaadawaaz://invite/${link}`,
      `https://azaadawaaz.org/#/invite/${link}`,
      `https://x.onion/#invite=${link}`,
      ` ${link} `,
    ])
      expect(extractInviteCode(text)).toBe(link);
    expect(extractInviteCode("https://azaadawaaz.org/")).toBeUndefined();
  });

  it("checks the owner's signature and expiry on the device", () => {
    const ok = parseInvite(`azaadawaaz://invite/${link}`, owner.pubkey);
    expect(ok.ok && ok.content.note).toBe("welcome");
    expect(parseInvite(link, modA.pubkey)).toEqual({ ok: false, error: "invite is not signed by the owner" });
    const expired = createInvite(owner.secretKey, { expiresAt: 10 });
    expect(parseInvite(expired.link, owner.pubkey)).toEqual({ ok: false, error: "invite expired" });
    expect(parseInvite("AAAA".repeat(12), owner.pubkey).ok).toBe(false);
  });

  it("makes a redemption the API accepts", () => {
    const r = redemptionFor(event, contributor.secretKey);
    expect(verifyRedemption(r, owner.pubkey)).toMatchObject({ ok: true, contributor: contributor.pubkey });
  });
});

describe("moderator feedback", () => {
  it("is readable only by the contributor", () => {
    const nip44 = encryptFeedback("Please blur the faces.", modA.secretKey, contributor.pubkey);
    const f = { at: "2026-01-01T00:00:00Z", moderator: modA.pubkey, kind: "changes" as const, nip44 };
    expect(decryptFeedback(f, contributor.secretKey).text).toBe("Please blur the faces.");
    expect(decryptFeedback(f, owner.secretKey).text).toBeNull();
    expect(canEdit({ state: "changes_requested" })).toBe(true);
    expect(canEdit({ state: "rejected" })).toBe(false);
  });
});
