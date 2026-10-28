/**
 * The reader's data layer (spec §8): official lists from bundled defaults, the IndexedDB cache, relays and IPFS list
 * copies, all verified against the pinned owner key; stories from relays via `selectStories`; manifests fetched by
 * hash from the fastest gateway and checked with `verifyManifest`. Framework-free so it can be tested directly.
 */
import { KIND_APP_DATA, KIND_STORY, MODERATOR_LISTS, OWNER_LISTS, listD, storageD } from "@core/kinds.js";
import { buildEffectiveLists, observeListEntries, type EffectiveLists, type FirstSeen } from "@core/lists.js";
import {
  parseStorageReceipt,
  selectStories,
  verifyManifest,
  type ManifestCheck,
  type StoryRef,
  type StorageReceipt,
} from "@core/stories.js";
import type { PublishResult, Filter } from "@core/relays.js";
import { verifyEventStrict } from "@core/keys.js";
import type { Event } from "nostr-tools/pure";
import type { AppConfig } from "../config.js";
import { idbGet, idbSet } from "../lib/idb.js";
import { fetchByCid, fetchBySha, setGateways } from "../lib/gateways.js";

export interface PoolLike {
  query(relays: string[], filter: Filter, timeoutMs?: number): Promise<Event[]>;
  subscribe(relays: string[], filter: Filter, onEvent: (e: Event) => void): () => void;
  publish(relays: string[], event: Event, timeoutMs?: number): Promise<PublishResult[]>;
}

export type ListsStatus = "loading" | "ready" | "none";

export interface LoadedManifest {
  check: ManifestCheck;
  bytes: Uint8Array;
  fromCache: boolean;
}

const MAX_CACHED_STORIES = 500;

export class AppData {
  readonly listEvents = new Map<string, Event>();
  readonly storyEvents = new Map<string, Event>();
  lists: EffectiveLists | null = null;
  /**
   * When this browser first saw each moderator-list entry. Moderators write their own `addedAt`, so the daily caps on
   * unlisting/hiding use the later of the two (core decision D18). Persisted in IndexedDB.
   */
  private firstSeen: FirstSeen = new Map();
  private firstSeenLoaded = false;
  stories: StoryRef[] = [];
  listsStatus: ListsStatus = "loading";
  storiesLoaded = false;
  /** True when the last refresh reached no relay at all. */
  offline = false;
  private readonly listeners = new Set<() => void>();
  private subs: (() => void)[] = [];
  private subKey = "";
  private readonly manifests = new Map<string, Promise<LoadedManifest>>();

  constructor(
    readonly config: AppConfig,
    readonly pool: PoolLike,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  get owner(): string {
    return this.config.ownerPubkey;
  }

  /** Relays to read from and publish to: bundled bootstrap relays plus the signed relay list. */
  relayUrls(): string[] {
    const fromLists = this.lists?.relays.map((r) => r.url) ?? [];
    return [...new Set([...fromLists, ...this.config.bootstrapRelays])];
  }

  publisherKeys(): string[] {
    return [...new Set((this.lists?.serviceKeys ?? []).filter((k) => k.role === "publisher").map((k) => k.pubkey))];
  }

  // ---------------------------------------------------------------- lists

  private addListEvents(events: Event[]): boolean {
    let added = false;
    for (const e of events) {
      if (!e || this.listEvents.has(e.id) || e.kind !== KIND_APP_DATA) continue;
      if (!e.tags.some((t) => t[0] === "d" && t[1]?.startsWith("azaad:list:"))) continue;
      this.listEvents.set(e.id, e);
      added = true;
    }
    return added;
  }

  private rebuildLists(): void {
    if (!this.owner) {
      this.lists = null;
      this.listsStatus = "none";
      return;
    }
    const events = [...this.listEvents.values()];
    observeListEntries(events, this.firstSeen);
    this.lists = buildEffectiveLists(this.owner, events, { firstSeen: this.firstSeen });
    if (this.firstSeenLoaded) void idbSet("lists:firstSeen", [...this.firstSeen.entries()]);
    setGateways(this.lists.gateways);
    const hasOwnerLists =
      this.lists.relays.length > 0 || this.lists.gateways.length > 0 || this.lists.moderators.length > 0;
    this.listsStatus = hasOwnerLists ? "ready" : this.listsStatus === "loading" ? "loading" : "none";
    // Re-select stories: unlisted entries or publisher keys may have changed.
    this.stories = selectStories([...this.storyEvents.values()], this.lists);
  }

  /** Load bundled and cached data, then refresh from the network in the background. */
  async init(): Promise<void> {
    this.addListEvents(this.config.listEvents);
    const seen = await idbGet<[string, number][]>("lists:firstSeen");
    if (seen) for (const [k, v] of seen) if (!this.firstSeen.has(k) || this.firstSeen.get(k)! > v) this.firstSeen.set(k, v);
    this.firstSeenLoaded = true;
    const cached = await idbGet<Event[]>("lists:events");
    if (cached) this.addListEvents(cached);
    const cachedStories = await idbGet<Event[]>("stories:events");
    for (const e of cachedStories ?? []) this.storyEvents.set(e.id, e);
    this.rebuildLists();
    if (this.storyEvents.size) this.storiesLoaded = true;
    this.emit();
  }

  /** Fetch the latest lists from relays (and IPFS copies), then stories. */
  async refresh(): Promise<void> {
    await this.refreshLists();
    await this.refreshStories();
    this.watch();
  }

  async refreshLists(): Promise<void> {
    if (!this.owner) {
      this.listsStatus = "none";
      this.emit();
      return;
    }
    const ownerFilter: Filter = { kinds: [KIND_APP_DATA], authors: [this.owner], "#d": OWNER_LISTS.map(listD) };
    const [fromRelays, fromIpfs] = await Promise.all([
      this.pool.query(this.relayUrls(), ownerFilter).catch(() => [] as Event[]),
      this.fetchListSnapshots(),
    ]);
    this.addListEvents([...fromRelays, ...fromIpfs]);
    this.rebuildLists();
    // The relay list may have grown, and moderators are now known: fetch moderator-signed lists everywhere.
    const signers = [this.owner, ...(this.lists?.activeModerators ?? [])];
    const modEvents = await this.pool
      .query(this.relayUrls(), {
        kinds: [KIND_APP_DATA],
        authors: signers,
        "#d": [...OWNER_LISTS, ...MODERATOR_LISTS].map(listD),
      })
      .catch(() => [] as Event[]);
    this.offline = fromRelays.length === 0 && modEvents.length === 0 && this.relayUrls().length > 0;
    this.addListEvents(modEvents);
    if (this.listsStatus === "loading") this.listsStatus = "none";
    this.rebuildLists();
    await idbSet("lists:events", this.lists?.sourceEvents ?? []);
    this.emit();
  }

  /** IPFS copies of the official lists: JSON arrays of signed events, each verified individually. */
  private async fetchListSnapshots(): Promise<Event[]> {
    const out: Event[] = [];
    for (const cid of this.config.listSnapshots) {
      try {
        const bytes = await fetchByCid(cid, 4 * 1024 * 1024);
        const arr = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (Array.isArray(arr)) out.push(...(arr as Event[]).filter((e) => verifyEventStrict(e)));
      } catch {
        // a missing copy is fine; relays and bundled defaults remain
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- stories

  private addStoryEvents(events: Event[]): void {
    for (const e of events) if (e?.kind === KIND_STORY) this.storyEvents.set(e.id, e);
  }

  async refreshStories(): Promise<void> {
    const authors = this.publisherKeys();
    if (authors.length === 0 || !this.lists) {
      this.storiesLoaded = true;
      this.emit();
      return;
    }
    const events = await this.pool
      .query(this.relayUrls(), { kinds: [KIND_STORY], authors, limit: 300 })
      .catch(() => [] as Event[]);
    this.addStoryEvents(events);
    this.stories = selectStories([...this.storyEvents.values()], this.lists);
    this.storiesLoaded = true;
    await this.saveStories();
    this.emit();
  }

  private async saveStories(): Promise<void> {
    if (!this.lists) return;
    const keep = selectStories([...this.storyEvents.values()], this.lists, { includeUnlisted: true })
      .slice(0, MAX_CACHED_STORIES)
      .map((s) => s.event);
    await idbSet("stories:events", keep);
  }

  /** Live updates: moderator lists (hides, unlistings) and new stories. */
  private watch(): void {
    const relays = this.relayUrls();
    const signers = this.owner ? [this.owner, ...(this.lists?.activeModerators ?? [])] : [];
    const key = JSON.stringify([relays, signers, this.publisherKeys()]);
    if (key === this.subKey || relays.length === 0 || signers.length === 0) return;
    this.unwatch();
    this.subKey = key;
    const since = Math.floor(Date.now() / 1000) - 60;
    this.subs.push(
      this.pool.subscribe(relays, { kinds: [KIND_APP_DATA], authors: signers, since }, (e) => {
        if (this.addListEvents([e])) {
          this.rebuildLists();
          void idbSet("lists:events", this.lists?.sourceEvents ?? []);
          this.emit();
          this.watch();
        }
      }),
    );
    const authors = this.publisherKeys();
    if (authors.length) {
      this.subs.push(
        this.pool.subscribe(relays, { kinds: [KIND_STORY], authors, since }, (e) => {
          this.addStoryEvents([e]);
          if (this.lists) this.stories = selectStories([...this.storyEvents.values()], this.lists);
          void this.saveStories();
          this.emit();
        }),
      );
    }
  }

  unwatch(): void {
    this.subs.forEach((s) => s());
    this.subs = [];
    this.subKey = "";
  }

  /** Find a story (latest version) by id, asking relays if it isn't loaded. `unlisted` is set for unlisted stories. */
  async getStory(storyId: string): Promise<{ ref: StoryRef; unlisted: boolean } | undefined> {
    if (!this.lists) return undefined;
    const local = () => {
      const all = selectStories([...this.storyEvents.values()], this.lists!, { includeUnlisted: true });
      const ref = all.find((s) => s.storyId === storyId);
      return ref ? { ref, unlisted: this.lists!.unlisted.has(storyId) } : undefined;
    };
    const have = local();
    if (have) return have;
    const authors = this.publisherKeys();
    if (!authors.length) return undefined;
    const events = await this.pool
      .query(this.relayUrls(), { kinds: [KIND_STORY], authors, "#d": [storyId] })
      .catch(() => [] as Event[]);
    this.addStoryEvents(events);
    await this.saveStories();
    return local();
  }

  // ---------------------------------------------------------------- manifests

  /** Fetch (or load from cache) and verify a story's manifest. Bytes are always re-verified, even from cache. */
  loadManifest(ref: StoryRef): Promise<LoadedManifest> {
    const key = ref.manifestSha256;
    let p = this.manifests.get(key);
    if (!p) {
      p = this.fetchManifest(ref);
      this.manifests.set(key, p);
      p.catch(() => this.manifests.delete(key));
    }
    return p;
  }

  private async fetchManifest(ref: StoryRef): Promise<LoadedManifest> {
    const lists = this.lists!;
    const cached = await idbGet<Uint8Array>(`manifest:${ref.manifestSha256}`);
    if (cached) {
      const check = verifyManifest(cached, ref, lists);
      if (check.checks.hash) return { check, bytes: cached, fromCache: true };
    }
    let bytes: Uint8Array;
    try {
      bytes = await fetchBySha({ cid: ref.manifestCid, sha256: ref.manifestSha256 }, { maxBytes: 4 * 1024 * 1024 });
    } catch (e) {
      // IPFS failed everywhere: look for the Arweave copy via the storage receipt.
      const receipt = await this.storageReceipt(ref.storyId, ref.version);
      const tx = receipt?.arweave[ref.manifestSha256];
      if (!tx) throw e;
      bytes = await fetchBySha({ sha256: ref.manifestSha256, arweave: tx }, { maxBytes: 4 * 1024 * 1024 });
    }
    const check = verifyManifest(bytes, ref, lists);
    if (check.checks.hash) await idbSet(`manifest:${ref.manifestSha256}`, bytes);
    return { check, bytes, fromCache: false };
  }

  /** Fetch bytes by hash for a manifest that is not announced by a current event (earlier versions). */
  async fetchManifestBytes(sha256: string, cid?: string, arweave?: string): Promise<Uint8Array> {
    const cached = await idbGet<Uint8Array>(`manifest:${sha256}`);
    if (cached) return cached;
    const bytes = await fetchBySha({ cid, sha256, arweave }, { maxBytes: 4 * 1024 * 1024 });
    await idbSet(`manifest:${sha256}`, bytes);
    return bytes;
  }

  // ---------------------------------------------------------------- storage receipts

  async storageReceipts(storyId: string, versions: number[]): Promise<StorageReceipt[]> {
    const authors = this.publisherKeys();
    if (!authors.length || !this.lists || versions.length === 0) return [];
    const events = await this.pool
      .query(this.relayUrls(), { kinds: [KIND_APP_DATA], authors, "#d": versions.map((v) => storageD(storyId, v)) })
      .catch(() => [] as Event[]);
    const best = new Map<number, StorageReceipt>();
    for (const e of events) {
      const r = parseStorageReceipt(e, this.lists);
      if (!r || r.storyId !== storyId) continue;
      const cur = best.get(r.version);
      if (!cur || r.createdAt > cur.createdAt) best.set(r.version, r);
    }
    return [...best.values()];
  }

  async storageReceipt(storyId: string, version: number): Promise<StorageReceipt | undefined> {
    return (await this.storageReceipts(storyId, [version]))[0];
  }

  // ---------------------------------------------------------------- publishing

  publish(event: Event): Promise<PublishResult[]> {
    return this.pool.publish(this.relayUrls(), event);
  }

  /** The newest moderator-tier list event signed by `author` (for read-modify-sign). */
  latestListEvent(author: string, name: string): Event | undefined {
    let best: Event | undefined;
    for (const e of this.listEvents.values()) {
      if (e.pubkey !== author || !e.tags.some((t) => t[0] === "d" && t[1] === listD(name as never))) continue;
      if (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id)) best = e;
    }
    return best;
  }

  /** Add a list event we just signed, so the UI reflects it immediately. */
  acceptListEvent(e: Event): void {
    if (this.addListEvents([e])) {
      this.rebuildLists();
      void idbSet("lists:events", this.lists?.sourceEvents ?? []);
      this.emit();
    }
  }
}
