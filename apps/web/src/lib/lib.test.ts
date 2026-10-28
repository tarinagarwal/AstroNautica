import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateKeyPair, verifyAuthHeader, KIND_AUDIT } from "@azaadawaaz/core";
import { renderMarkdown } from "./markdown.js";
import { RECEIPT_SELECTOR, PUBLISHED_TOPIC, decodePublishedData, encodeReceiptCall, checkChainReceipt } from "./eth.js";
import { seal, unseal, WrongPassphraseError } from "./vault.js";
import { Api, ApiError } from "./api.js";
import { localSigner } from "./signer.js";
import { pickVariant } from "../components/VerifiedImage.js";
import { createAuditEvent } from "../data/moderation.js";
import { PUBLISHER_EVM, createWorld, publishStory, rpcReply, textStory } from "../test/world.js";
import { TEST_URLS } from "../test/fakes.js";

describe("safe Markdown", () => {
  it("escapes raw HTML and drops images", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>\n\n![pic](https://tracker.example/p.png)\n\n<b>bold</b>");
    expect(html).not.toMatch(/<img|<b>/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("only links http(s)/mailto, and external links get noopener noreferrer", () => {
    const html = renderMarkdown(
      "[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.org) [d](mailto:x@example.org)",
    );
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('<a href="https://example.org" target="_blank" rel="noopener noreferrer">c</a>');
    expect(html).toContain('href="mailto:x@example.org"');
  });

  it("renders headings, emphasis, quotes and lists", () => {
    const html = renderMarkdown("# H\n\n**b** *i*\n\n> q\n\n- one\n- two");
    expect(html).toContain("<h1>H</h1>");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<li>two</li>");
  });
});

describe("registry JSON-RPC", () => {
  it("uses the ABI's receipt selector and Published topic", () => {
    const sel = (s: string) => "0x" + bytesToHex(keccak_256(new TextEncoder().encode(s)));
    expect(RECEIPT_SELECTOR).toBe(sel("receipt(bytes16,uint32,address)").slice(0, 10));
    expect(PUBLISHED_TOPIC).toBe(sel("Published(bytes16,uint32,address,bytes32,string,uint64)"));
    expect(encodeReceiptCall("01928f3e-7c1a-7b2c-8d3e-4f5a6b7c8d9e", 3, "0x" + "AB".repeat(20))).toBe(
      RECEIPT_SELECTOR +
        "01928f3e7c1a7b2c8d3e4f5a6b7c8d9e" +
        "0".repeat(32) +
        "0".repeat(63) +
        "3" +
        "0".repeat(24) +
        "ab".repeat(20),
    );
  });

  it("decodes Published event data and checks a receipt against the manifest hash", async () => {
    const world = await createWorld(TEST_URLS);
    const b = publishStory(world, textStory(world, "Chain"));
    const rpc = (async (_u: string, init: RequestInit) => {
      const r = rpcReply(world, String(init.body));
      return new Response(r.body as string, { status: r.status });
    }) as unknown as typeof fetch;
    const chain = { key: "x", chainId: 31337, rpc: TEST_URLS.rpc, registry: world.registry };
    const pubs = [{ address: PUBLISHER_EVM, from: 0 }];
    const ok = await checkChainReceipt(chain, b.manifest.id, 1, b.sha256, pubs, rpc);
    expect(ok).toMatchObject({ ok: true, manifestSha256: b.sha256, manifestCid: b.cid });
    const bad = await checkChainReceipt(chain, b.manifest.id, 1, "ab".repeat(32), pubs, rpc);
    expect(bad).toMatchObject({ ok: false, error: "mismatch" });
    const missing = await checkChainReceipt(chain, b.manifest.id, 2, b.sha256, pubs, rpc);
    expect(missing).toMatchObject({ ok: false, error: "not-found" });
    // A receipt by an address that wasn't the publisher at that time doesn't count.
    const stranger = await checkChainReceipt(
      chain,
      b.manifest.id,
      1,
      b.sha256,
      [{ address: "0x" + "ee".repeat(20), from: 0 }],
      rpc,
    );
    expect(stranger).toMatchObject({ ok: false, error: "not-found" });
    const expired = await checkChainReceipt(
      chain,
      b.manifest.id,
      1,
      b.sha256,
      [{ address: PUBLISHER_EVM, from: 0, until: 1 }],
      rpc,
    );
    expect(expired.ok).toBe(false);
    const down = await checkChainReceipt(
      chain,
      b.manifest.id,
      1,
      b.sha256,
      pubs,
      (async () => new Response("", { status: 502 })) as never,
    );
    expect(down).toMatchObject({ ok: false, error: "unreachable" });
    const d =
      "0x" +
      "cd".repeat(32) +
      "0".repeat(62) +
      "60" +
      "0".repeat(56) +
      "65432100" +
      "0".repeat(63) +
      "4" +
      "62616679" +
      "0".repeat(56);
    expect(decodePublishedData(d)).toEqual({ sha: "cd".repeat(32), cid: "bafy", timestamp: 0x65432100 });
  });
});

describe("key vault", () => {
  it("round-trips secrets with the right passphrase and refuses the wrong one", async () => {
    const s = await seal({ secret: "ab".repeat(32) }, "correct horse battery", 1000);
    expect(JSON.stringify(s)).not.toContain("abab");
    expect(await unseal(s, "correct horse battery")).toEqual({ secret: "ab".repeat(32) });
    await expect(unseal(s, "wrong passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe("API client (NIP-98)", () => {
  it("signs the full URL, method and exact body; parses API errors", async () => {
    const kp = generateKeyPair();
    const seen: { url: string; auth: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization")!;
      seen.push({ url, auth, body: init.body as string });
      const v = verifyAuthHeader(auth, url, init.method!, init.body as string);
      if (!v.ok) return new Response(JSON.stringify({ error: "unauthorized", message: v.error }), { status: 401 });
      if (url.endsWith("/claim"))
        return new Response(JSON.stringify({ error: "conflict", message: "already claimed" }), { status: 409 });
      return new Response(JSON.stringify([{ id: "1", story_id: "s", state: "submitted" }]));
    }) as unknown as typeof fetch;
    const api = new Api("http://api.test/", localSigner(kp.secretKey), fetchImpl);
    const q = await api.queue();
    expect(q[0]).toMatchObject({ id: "1", storyId: "s" });
    expect(seen[0]!.url).toBe("http://api.test/queue");
    const err = await api.claim("abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "conflict" });
    expect(seen[1]!.body).toBe("{}");
  });

  it("needs a configured API and a key for authenticated routes", async () => {
    await expect(new Api("").health()).rejects.toMatchObject({ code: "no_api" });
    await expect(new Api("http://api.test").queue()).rejects.toMatchObject({ code: "no_key" });
  });
});

describe("helpers", () => {
  it("audit events follow the architecture contract", () => {
    const kp = generateKeyPair();
    const e = createAuditEvent(kp.secretKey, "reject", { submissionId: "abc", storyId: "never-included" });
    expect(e.kind).toBe(KIND_AUDIT);
    expect(e.content).toBe("");
    expect(e.tags.map((t) => t[0])).toEqual(["action", "s"]);
    const u = createAuditEvent(kp.secretKey, "unlist", { storyId: "story-1" });
    expect(u.tags).toEqual([
      ["action", "unlist"],
      ["story", "story-1"],
    ]);
  });

  it("picks the smallest image variant wide enough", () => {
    const v = { "480": "a", "960": "b", "1600": "c" };
    expect(pickVariant(v, 300)).toBe("a");
    expect(pickVariant(v, 700)).toBe("b");
    expect(pickVariant(v, 3000, 1600)).toBe("c");
    expect(pickVariant(v, 3000, 4000)).toBeUndefined();
    expect(pickVariant(undefined, 300)).toBeUndefined();
  });
});
