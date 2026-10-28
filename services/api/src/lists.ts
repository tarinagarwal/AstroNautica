/**
 * The effective signed lists (spec §3, decision D5): owner-signed and moderator-signed list events loaded from the
 * relays every 30 s (and from an optional bootstrap file), combined with `core.buildEffectiveLists`. Roles and the
 * staging-encryption recipients come from here.
 */
import { readFile } from "node:fs/promises";
import {
  KIND_APP_DATA,
  MODERATOR_LISTS,
  OWNER_LISTS,
  buildEffectiveLists,
  currentPublisher,
  listD,
  parseListEvent,
  type EffectiveLists,
  type Event,
  type Filter,
  type ModeratorEntry,
  type ServiceKeyEntry,
} from "@azaadawaaz/core";
import { scrubAddresses } from "./privacy.js";

export interface RelayQuery {
  query(relays: string[], filter: Filter, timeoutMs?: number): Promise<Event[]>;
}

export interface ListsLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface ListsServiceOptions {
  ownerPubkey: string;
  /** Relays to load lists from (in addition to the relays on the owner-signed relay list). */
  relays?: string[];
  pool?: RelayQuery;
  refreshMs?: number;
  now?: () => number;
  log?: ListsLogger;
}

const ALL_D_TAGS = [...OWNER_LISTS, ...MODERATOR_LISTS].map((n) => listD(n));
const CACHE_MS = 5_000;

export class ListsService {
  private readonly events = new Map<string, Event>();
  private cached: { at: number; lists: EffectiveLists } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  readonly ownerPubkey: string;

  constructor(private readonly opts: ListsServiceOptions) {
    this.ownerPubkey = opts.ownerPubkey;
  }

  private nowSec(): number {
    return Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
  }

  /** Add list events (from relays, a bootstrap file or tests). Keeps only the newest valid event per signer and list. */
  feed(events: Event[]): number {
    const now = this.nowSec();
    let accepted = 0;
    for (const e of events) {
      const p = parseListEvent(e, now);
      if (!p) continue;
      const key = `${p.author}|${p.name}`;
      const prev = this.events.get(key);
      if (prev && (prev.created_at > e.created_at || (prev.created_at === e.created_at && prev.id <= e.id))) continue;
      this.events.set(key, e);
      accepted++;
    }
    if (accepted) this.cached = undefined;
    return accepted;
  }

  /** Load a JSON array of signed list events from a file (BOOTSTRAP_LIST_EVENTS). */
  async loadBootstrap(path: string): Promise<number> {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(data)) throw new Error(`${path} must contain a JSON array of signed events`);
    return this.feed(data as Event[]);
  }

  current(): EffectiveLists {
    const nowMs = this.opts.now?.() ?? Date.now();
    if (!this.cached || nowMs - this.cached.at > CACHE_MS) {
      this.cached = {
        at: nowMs,
        lists: buildEffectiveLists(this.ownerPubkey, [...this.events.values()], { now: Math.floor(nowMs / 1000) }),
      };
    }
    return this.cached.lists;
  }

  /** True once the owner-signed moderator and service-key lists are known. */
  ready(): boolean {
    return this.events.has(`${this.ownerPubkey}|moderators`) && this.events.has(`${this.ownerPubkey}|service-keys`);
  }

  isOwner(pubkey: string): boolean {
    return pubkey === this.ownerPubkey;
  }

  /** Active moderator, or the owner (who can do everything a moderator can, spec §2). */
  isModerator(pubkey: string): boolean {
    return this.isOwner(pubkey) || this.current().activeModerators.has(pubkey);
  }

  activeModerators(): ModeratorEntry[] {
    const l = this.current();
    return l.moderators.filter((m) => l.activeModerators.has(m.pubkey));
  }

  ownerEntry(): ServiceKeyEntry | undefined {
    const now = this.nowSec();
    return this.current().serviceKeys.find(
      (k) =>
        k.role === "owner" &&
        k.pubkey === this.ownerPubkey &&
        k.from <= now &&
        (k.until === undefined || now < k.until),
    );
  }

  ownerX25519(): string | undefined {
    return this.ownerEntry()?.x25519;
  }

  publisher(): ServiceKeyEntry | undefined {
    return currentPublisher(this.current(), this.nowSec());
  }

  /** Every publisher X25519 key on the list (current or not): none of them may receive a pre-approval wrap. */
  publisherX25519Keys(): Set<string> {
    return new Set(
      this.current()
        .serviceKeys.filter((k) => k.role === "publisher" && k.x25519)
        .map((k) => k.x25519!),
    );
  }

  /** The X25519 keys every submission's content key must be wrapped for: the owner and each active moderator. */
  requiredRecipients(): string[] {
    const keys = new Set<string>();
    const owner = this.ownerX25519();
    if (owner) keys.add(owner);
    for (const m of this.activeModerators()) keys.add(m.x25519);
    return [...keys];
  }

  /** The caller's own listed X25519 key (owner or active moderator). */
  x25519For(pubkey: string): string | undefined {
    if (this.isOwner(pubkey)) return this.ownerX25519();
    return this.activeModerators().find((m) => m.pubkey === pubkey)?.x25519;
  }

  /** Relays operated by us (owner-signed relay list), falling back to the configured relays. */
  ownRelays(): string[] {
    const own = this.current()
      .relays.filter((r) => r.operator === "own")
      .map((r) => r.url);
    return own.length ? own : (this.opts.relays ?? []);
  }

  private queryRelays(): string[] {
    return [...new Set([...(this.opts.relays ?? []), ...this.current().relays.map((r) => r.url)])];
  }

  /** Load the newest list events from the relays. Never throws; failures keep the previous lists. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const pool = this.opts.pool;
    if (!pool) return;
    const queried = new Set<string>();
    try {
      // Two passes: the first may reveal moderators (from the owner's list) whose own lists we have not loaded yet.
      for (let pass = 0; pass < 2; pass++) {
        const authors = [this.ownerPubkey, ...this.current().activeModerators].filter((a) => !queried.has(a));
        if (authors.length === 0) break;
        authors.forEach((a) => queried.add(a));
        const relays = this.queryRelays();
        if (relays.length === 0) return;
        const events = await pool.query(relays, { kinds: [KIND_APP_DATA], authors, "#d": ALL_D_TAGS });
        this.feed(events);
        this.cached = undefined;
      }
    } catch (e) {
      this.opts.log?.warn({ err: scrubAddresses(e instanceof Error ? e.message : String(e)) }, "list refresh failed");
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
