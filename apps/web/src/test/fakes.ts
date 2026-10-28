import { matchFilter, type Filter } from "nostr-tools/filter";
import type { Event } from "nostr-tools/pure";
import type { PoolLike } from "../data/appData.js";
import { arweaveReply, gatewayReply, rpcReply, type HttpReply, type Tamper, type World } from "./world.js";

/** An in-memory relay pool: stores events, answers filters, and pushes new events to live subscriptions. */
export class FakePool implements PoolLike {
  events: Event[] = [];
  published: Event[] = [];
  private subs: { filter: Filter; fn: (e: Event) => void }[] = [];

  constructor(initial: Event[] = []) {
    this.events.push(...initial);
  }

  async query(_relays: string[], filter: Filter): Promise<Event[]> {
    const out = this.events.filter((e) => matchFilter(filter, e));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  subscribe(_relays: string[], filter: Filter, fn: (e: Event) => void): () => void {
    const s = { filter, fn };
    this.subs.push(s);
    return () => {
      this.subs = this.subs.filter((x) => x !== s);
    };
  }

  /** Simulates an event arriving at the relay from someone else. */
  push(e: Event): void {
    this.events.push(e);
    for (const s of this.subs) if (matchFilter({ ...s.filter, since: undefined }, e)) s.fn(e);
  }

  async publish(relays: string[], e: Event) {
    this.published.push(e);
    this.push(e);
    return relays.map((relay) => ({ relay, ok: true, message: "" }));
  }
}

/** A fetch that answers like the world's gateway, Arweave gateway and chain RPC. */
export function worldFetch(world: World, tamper?: Tamper) {
  const calls: string[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    let r: HttpReply;
    const headers = new Headers(init?.headers);
    if (url.origin === new URL(world.urls.gateway).origin)
      r = gatewayReply(world, url.pathname, url.searchParams, headers.get("accept") ?? "", tamper);
    else if (url.origin === new URL(world.urls.arweave).origin) r = arweaveReply(world, url.pathname);
    else if (url.origin === new URL(world.urls.rpc).origin) r = rpcReply(world, String(init?.body ?? ""));
    else r = { status: 404, body: "unknown host" };
    const body = (typeof r.body === "string" ? r.body : r.body) as BodyInit;
    return new Response(body, { status: r.status, headers: { "content-type": r.type ?? "text/plain" } });
  };
  return Object.assign(f, { calls });
}

export const TEST_URLS = {
  relay: "wss://relay.test",
  gateway: "http://gw.test",
  arweave: "http://ar.test",
  rpc: "http://rpc.test",
};
