import { createHash } from "node:crypto";
import { createAuthHeader, verifyAuthHeader } from "@azaadawaaz/core";
import { contributor } from "../../test/fixtures";
import { createAuthHeaderForHash, signerFromSecret } from "../nip98";

describe("NIP-98 for file uploads", () => {
  it("is accepted by the API's verifier for the actual body bytes", () => {
    const body = Uint8Array.from({ length: 1024 * 1024 + 17 }, (_, i) => i & 255);
    const url = "https://api.example/submissions/x/media/y/chunks/0";
    const h = createAuthHeaderForHash(
      url,
      "put",
      contributor.secretKey,
      createHash("sha256").update(body).digest("hex"),
    );
    expect(verifyAuthHeader(h, url, "PUT", body)).toMatchObject({ ok: true, pubkey: contributor.pubkey });
    expect(verifyAuthHeader(h, url, "PUT", body.slice(1))).toEqual({ ok: false, error: "payload mismatch" });
    expect(verifyAuthHeader(h, url + "?x", "PUT", body).ok).toBe(false);
  });

  it("matches core's header for in-memory bodies", () => {
    const s = signerFromSecret(contributor.secretKey);
    const url = "https://api.example/submissions";
    const h = s.authHeader(url, "POST", '{"a":1}');
    expect(verifyAuthHeader(h, url, "POST", '{"a":1}').ok).toBe(true);
    expect(verifyAuthHeader(createAuthHeader(url, "GET", contributor.secretKey), url, "GET").ok).toBe(true);
    expect(s.pubkey).toBe(contributor.pubkey);
  });
});
