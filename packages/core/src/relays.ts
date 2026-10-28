import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";

export type { Filter };

export interface PublishResult {
  relay: string;
  ok: boolean;
  message?: string;
}

/**
 * A pool of relays with the behaviour AzaadAwaaz needs: query many relays and merge (dedupe) results, tolerate any
 * subset being down or blocked, and publish to all with a per-relay result (spec §1.1 principle 5).
 */
export class RelayPool {
  private readonly pool: SimplePool;

  /**
   * In Node, pass `ws` as `websocketImplementation`: Node's built-in WebSocket overflows the stack inside nostr-tools
   * when a relay is unreachable. Browsers and React Native use their native WebSocket.
   */
  constructor(opts: { websocketImplementation?: unknown } = {}) {
    this.pool = new SimplePool(
      opts.websocketImplementation ? ({ websocketImplementation: opts.websocketImplementation } as never) : undefined,
    );
  }

  /** Query all relays; resolves with deduplicated events once every relay has answered (EOSE) or timed out. */
  async query(relays: string[], filter: Filter, timeoutMs = 8000): Promise<Event[]> {
    if (relays.length === 0) return [];
    const byId = new Map<string, Event>();
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        sub.close();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const sub = this.pool.subscribeMany(relays, filter, {
        onevent: (e: Event) => {
          if (!byId.has(e.id)) byId.set(e.id, e);
        },
        oneose: finish,
        maxWait: timeoutMs,
      });
    });
    return [...byId.values()];
  }

  /** Live subscription; returns a function that closes it. */
  subscribe(relays: string[], filter: Filter, onEvent: (e: Event) => void): () => void {
    const seen = new Set<string>();
    const sub = this.pool.subscribeMany(relays, filter, {
      onevent: (e: Event) => {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        onEvent(e);
      },
    });
    return () => sub.close();
  }

  /** Publish to every relay; never throws, reports per relay. */
  async publish(relays: string[], event: Event, timeoutMs = 10_000): Promise<PublishResult[]> {
    const promises = this.pool.publish(relays, event);
    return Promise.all(
      promises.map(async (p, i) => {
        const relay = relays[i]!;
        try {
          const message = await Promise.race([
            p,
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
          ]);
          return { relay, ok: true, message: String(message ?? "") };
        } catch (e) {
          return { relay, ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }

  close(relays?: string[]): void {
    if (relays) this.pool.close(relays);
    else this.pool.destroy();
  }
}
