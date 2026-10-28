/**
 * An in-memory stand-in for services/api that follows docs/architecture.md: it checks every NIP-98 header with
 * core `verifyAuthHeader` (full URL, method, payload hash) and implements the submission, media and moderation
 * routes the web client uses.
 */
import { verifyAuthHeader, type Event } from "@azaadawaaz/core";
import type { World } from "./world.js";

export interface StoredSubmission {
  id: string;
  storyId: string;
  version: number;
  supersedes: string | null;
  contributor: string;
  state: string;
  bodyCiphertext: string;
  wrappedKeys: Record<string, string>;
  media: {
    sha256: string;
    size: number;
    mime: string;
    kind: string;
    chunks: number;
    header?: Uint8Array;
    parts: Map<number, Uint8Array>;
    complete: boolean;
  }[];
  approval?: unknown;
  approvalBodySha256?: string;
  publisherWrappedKey?: string;
  feedback: { at: string; moderator: string; kind: string; nip44: string }[];
  audit: Event[];
}

export function mockApi(world: World, base = "http://api.test") {
  const subs = new Map<string, StoredSubmission>();
  const audit: Event[] = [];
  const unlisted: string[] = [];
  let failChunk: { sha?: string; n: number } | null = null;
  let seq = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, error: string) => json(status, { error, message: error });

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;
    const body = init.body as string | Uint8Array | undefined;
    const headers = new Headers(init.headers);
    if (path === "/config")
      return json(200, {
        ownerPubkey: world.owner.pubkey,
        ownerX25519: world.ownerX.publicKey,
        publisher: { pubkey: world.publisher.pubkey, x25519: world.publisherX.publicKey },
        moderators: [{ pubkey: world.moderator.pubkey, x25519: world.moderatorX.publicKey }],
        relays: [world.urls.relay],
        gateways: [],
        limits: {},
      });
    const auth = verifyAuthHeader(headers.get("authorization") ?? undefined, url, method, body);
    if (!auth.ok) return err(401, auth.error);
    const who = auth.pubkey;
    const isMod = who === world.moderator.pubkey || who === world.owner.pubkey;
    const parsed = typeof body === "string" && body ? JSON.parse(body) : undefined;

    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/submissions") {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      subs.set(id, {
        id,
        ...parsed,
        contributor: who,
        state: "draft",
        media: parsed.media.map((x: StoredSubmission["media"][number]) => ({
          ...x,
          parts: new Map(),
          complete: false,
        })),
        feedback: [],
        audit: [],
      });
      return json(200, { id });
    }
    if ((m = path.match(/^\/submissions\/([^/]+)$/))) {
      const s = subs.get(m[1]!);
      if (!s) return err(404, "not_found");
      if (method === "PUT") {
        if (s.contributor !== who || !["draft", "changes_requested"].includes(s.state)) return err(409, "bad_state");
        const keep = new Map(s.media.map((x) => [x.sha256, x]));
        Object.assign(s, parsed, {
          media: parsed.media.map(
            (x: StoredSubmission["media"][number]) => keep.get(x.sha256) ?? { ...x, parts: new Map(), complete: false },
          ),
        });
        return json(200, {});
      }
      if (s.contributor !== who && !isMod) return err(403, "forbidden");
      const x = u.searchParams.get("x25519");
      return json(200, {
        id: s.id,
        storyId: s.storyId,
        version: s.version,
        supersedes: s.supersedes,
        contributor: s.contributor,
        state: s.state,
        bodyCiphertext: s.bodyCiphertext,
        wrappedKey: x ? (s.wrappedKeys[x] ?? null) : null,
        media: s.media.map(({ sha256, size, mime, kind, chunks, complete }) => ({
          sha256,
          size,
          mime,
          kind,
          chunks,
          complete,
        })),
      });
    }
    if ((m = path.match(/^\/submissions\/([^/]+)\/media\/([0-9a-f]{64})\/(header|status|complete|chunks\/(\d+))$/))) {
      const s = subs.get(m[1]!);
      const media = s?.media.find((x) => x.sha256 === m![2]);
      if (!s || !media) return err(404, "not_found");
      const what = m[3]!;
      if (method === "PUT" && what === "header") {
        media.header = body as Uint8Array;
        return json(200, {});
      }
      if (method === "PUT" && what.startsWith("chunks/")) {
        const n = Number(m[4]);
        if (failChunk && failChunk.n === n && (!failChunk.sha || failChunk.sha === media.sha256)) {
          failChunk = null;
          return err(503, "unavailable");
        }
        media.parts.set(n, body as Uint8Array);
        return json(200, {});
      }
      if (method === "GET" && what === "status")
        return json(200, { received: [...media.parts.keys()].sort((a, b) => a - b), complete: media.complete });
      if (method === "POST" && what === "complete") {
        for (let i = 0; i < media.chunks; i++) if (!media.parts.has(i)) return err(409, "missing_chunks");
        if (!media.header) return err(409, "missing_header");
        media.complete = true;
        return json(200, {});
      }
      if (method === "GET" && what === "header") return new Response(media.header as BodyInit);
      if (method === "GET" && what.startsWith("chunks/"))
        return new Response(media.parts.get(Number(m[4])) as BodyInit);
    }
    if ((m = path.match(/^\/submissions\/([^/]+)\/(submit|claim|approve|reject|request-changes|keys)$/))) {
      const s = subs.get(m[1]!);
      if (!s) return err(404, "not_found");
      switch (m[2]) {
        case "submit":
          if (!s.media.every((x) => x.complete)) return err(409, "media_incomplete");
          s.state = "submitted";
          break;
        case "claim":
          if (!isMod) return err(403, "forbidden");
          if (s.state === "submitted") s.state = "in_review";
          break;
        case "approve":
          if (!isMod) return err(403, "forbidden");
          if (s.approval) return err(409, "already_approved");
          Object.assign(s, {
            state: "approved",
            approval: parsed.approval,
            approvalBodySha256: parsed.approvalBodySha256,
            publisherWrappedKey: parsed.publisherWrappedKey,
          });
          s.audit.push(parsed.auditEvent);
          audit.push(parsed.auditEvent);
          break;
        case "reject":
        case "request-changes":
          if (!isMod) return err(403, "forbidden");
          s.state = m[2] === "reject" ? "rejected" : "changes_requested";
          s.feedback.push({
            at: new Date().toISOString(),
            moderator: who,
            kind: m[2] === "reject" ? "reject" : "changes",
            nip44: parsed.feedback,
          });
          audit.push(parsed.auditEvent);
          break;
        case "keys":
          Object.assign(s.wrappedKeys, parsed.wrappedKeys);
          break;
      }
      return json(200, {});
    }
    if (path === "/me/submissions")
      return json(
        200,
        [...subs.values()]
          .filter((s) => s.contributor === who)
          .map((s) => ({
            id: s.id,
            storyId: s.storyId,
            version: s.version,
            state: s.state,
            feedback: s.feedback,
            createdAt: "2026-10-28T00:00:00Z",
            updatedAt: "2026-10-28T00:00:00Z",
            manifestCid: null,
            publishedAt: null,
          })),
      );
    if (path === "/queue")
      return json(
        200,
        [...subs.values()]
          .filter((s) => ["submitted", "in_review"].includes(s.state))
          .map((s) => ({
            id: s.id,
            storyId: s.storyId,
            version: s.version,
            state: s.state,
            contributor: s.contributor,
          })),
      );
    if (path === "/moderation/unlist") {
      unlisted.push(parsed.storyId);
      audit.push(parsed.auditEvent);
      return json(200, {});
    }
    if (path === "/moderation/audit") {
      audit.push(parsed.auditEvent);
      return json(200, {});
    }
    return err(404, "no_route");
  };

  return {
    base,
    fetch: fetchImpl as typeof fetch,
    subs,
    audit,
    unlisted,
    failNextChunk: (n: number, sha?: string) => {
      failChunk = { n, sha };
    },
  };
}
