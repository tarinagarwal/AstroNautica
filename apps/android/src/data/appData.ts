/**
 * The reader's data layer (spec §8): official lists from bundled defaults, the on-device cache, relays and IPFS list
 * copies, all verified against the pinned owner key; stories from relays via core `selectStories`; manifests fetched
 * by hash from the fastest gateway and checked with core `verifyManifest`. Framework-free, tested in Node.
 */
import {
  KIND_APP_DATA,
  KIND_STORY,
  MODERATOR_LISTS,
  OWNER_LISTS,
  buildEffectiveLists,
  observeListEntries,
  listD,
  parseStorageReceipt,
  selectStories,
  storageD,
  verifyEventStrict,
  verifyManifest,
  type EffectiveLists,
  type FirstSeen,
  type Event,
  type Filter,
  type ManifestCheck,
  type PublishResult,
  type StorageReceipt,
  type StoryRef,
} from "@azaadawaaz/core";
import type { AppConfig } from "../config";
import type { JsonStore } from "../platform/kv";
import { joinPath, type FileSystem } from "../platform/types";
import type { GatewayClient } from "./gateways";

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
const MANIFEST_MAX = 4 * 1024 * 1024;

export class AppData {
  readonly listEvents = new Map<string, Event>();
  readonly storyEvents = new Map<string, Event>();
  lists: EffectiveLists | null = null;
  stories: StoryRef[] = [];
  listsStatus: ListsStatus = "loading";
  storiesLoaded = false;
  /** Relays answered nothing on the last refresh (all unreachable or blocked). */
  relaysUnreachable = false;
  private readonly listeners = new Set<() => void>();
  private subs: (() => void)[] = [];
  private subKey = "";
  private readonly manifests = new Map<string, Promise<LoadedManifest>>();
  /** When this device first saw each moderator-list entry (persisted; feeds the daily caps, decision D18). */
  readonly firstSeen: FirstSeen = new Map();
  private firstSeenSize = 0;

  constructor(
    readonly config: AppConfig,
    readonly pool: PoolLike,
    readonly gateways: GatewayClient,
    private readonly store: JsonStore,
    private readonly fs: FileSystem,
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

  /** Relays to read from and publish to: the signed relay list plus the bundled bootstrap relays. */
  relayUrls(): string[] {
    const fromLists = this.lists?.relays.map((r) => r.url) ?? [];
    return [...new Set([...fromLists, ...this.config.bootstrapRelays])];
  }

  publisherKeys(): string[] {
    return [...new Set((this.lists?.serviceKeys ?? []).filter((k) => k.role === "publisher").map((k) => k.pubkey))];
  }

  // ---------------------------------------------------------------- lists

  /** Add list events from any source; returns true when something new was added. Signatures are checked later. */
  addListEvents(events: Event[]): boolean {
    let added = false;
    for (const e of events) {
      if (!e || typeof e.id !== "string" || this.listEvents.has(e.id) || e.kind !== KIND_APP_DATA) continue;
      if (!e.tags?.some((t) => t[0] === "d" && t[1]?.startsWith("azaad:list:"))) continue;
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
    if (this.firstSeen.size !== this.firstSeenSize) {
      this.firstSeenSize = this.firstSeen.size;
      void this.store.set("lists:firstSeen", [...this.firstSeen]);
    }
    this.lists = buildEffectiveLists(this.owner, events, { firstSeen: this.firstSeen });
    this.gateways.setGateways(this.lists.gateways);
    const hasOwnerLists =
      this.lists.relays.length > 0 || this.lists.gateways.length > 0 || this.lists.moderators.length > 0;
    this.listsStatus = hasOwnerLists ? "ready" : this.listsStatus === "loading" ? "loading" : "none";
    this.stories = selectStories([...this.storyEvents.values()], this.lists);
  }

  /** Load bundled and cached data (no network). */
  async init(): Promise<void> {
    for (const [k, v] of (await this.store.get<[string, number][]>("lists:firstSeen")) ?? []) this.firstSeen.set(k, v);
    this.firstSeenSize = this.firstSeen.size;
    this.addListEvents(this.config.listEvents);
    this.addListEvents((await this.store.get<Event[]>("lists:events")) ?? []);
    for (const e of (await this.store.get<Event[]>("stories:events")) ?? []) this.storyEvents.set(e.id, e);
    this.rebuildLists();
    if (this.storyEvents.size) this.storiesLoaded = true;
    this.emit();
  }

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
    const signers = [this.owner, ...(this.lists?.activeModerators ?? [])];
    const modEvents = await this.pool
      .query(this.relayUrls(), {
        kinds: [KIND_APP_DATA],
        authors: signers,
        "#d": [...OWNER_LISTS, ...MODERATOR_LISTS].map(listD),
      })
      .catch(() => [] as Event[]);
    this.relaysUnreachable = fromRelays.length === 0 && modEvents.length === 0 && this.relayUrls().length > 0;
    this.addListEvents(modEvents);
    if (this.listsStatus === "loading") this.listsStatus = "none";
    this.rebuildLists();
    await this.store.set("lists:events", this.lists?.sourceEvents ?? []);
    this.emit();
  }

  /** IPFS copies of the official lists: JSON arrays of signed events, each verified individually. */
  private async fetchListSnapshots(): Promise<Event[]> {
    const out: Event[] = [];
    for (const cid of this.config.listSnapshots) {
      try {
        const bytes = await this.gateways.fetchByCid(cid, 4 * 1024 * 1024);
        const arr = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (Array.isArray(arr)) out.push(...(arr as Event[]).filter((e) => verifyEventStrict(e)));
      } catch {
        // a missing copy is fine; relays and bundled defaults remain
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- stories

  addStoryEvents(events: Event[]): void {
    for (const e of events) if (e?.kind === KIND_STORY && typeof e.id === "string") this.storyEvents.set(e.id, e);
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
    await this.store.set("stories:events", keep);
  }

  featured(): StoryRef[] {
    const f = this.lists?.featured;
    return f ? this.stories.filter((s) => f.has(s.storyId)) : [];
  }

  byTag(tag: string): StoryRef[] {
    const t = tag.toLowerCase();
    return this.stories.filter((s) => s.tags.some((x) => x.toLowerCase() === t));
  }

  /** Case-insensitive search over titles, summaries and tags of the stories we know. */
  search(query: string): StoryRef[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return this.stories.filter((s) => {
      const hay = [s.title, s.summary, ...s.tags, s.event.tags.find((t) => t[0] === "title-hi")?.[1] ?? ""]
        .join(" ")
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  /** Live updates: moderator lists (hides, unlistings) and new stories. */
  watch(): void {
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
          void this.store.set("lists:events", this.lists?.sourceEvents ?? []);
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

  /** Find a story (latest version) by id, asking relays when it isn't loaded. */
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

  private manifestPath(sha: string): string {
    return joinPath(this.fs.paths.files, "manifests", sha);
  }

  /** Fetch (or load from the device) and verify a story's manifest. Cached bytes are always re-verified. */
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

  private async readCachedManifest(sha: string): Promise<Uint8Array | undefined> {
    try {
      return await this.fs.readBytes(this.manifestPath(sha));
    } catch {
      return undefined;
    }
  }

  private async cacheManifest(sha: string, bytes: Uint8Array): Promise<void> {
    await this.fs.mkdirs(joinPath(this.fs.paths.files, "manifests"));
    await this.fs.writeBytes(this.manifestPath(sha), bytes);
  }

  private async fetchManifest(ref: StoryRef): Promise<LoadedManifest> {
    const lists = this.lists;
    if (!lists) throw new Error("official lists are not loaded");
    const cached = await this.readCachedManifest(ref.manifestSha256);
    if (cached) {
      const check = verifyManifest(cached, ref, lists);
      if (check.checks.hash) return { check, bytes: cached, fromCache: true };
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.gateways.fetchBySha({ cid: ref.manifestCid, sha256: ref.manifestSha256 }, { maxBytes: MANIFEST_MAX });
    } catch (e) {
      // IPFS failed everywhere: look for the Arweave copy via the storage receipt (decision D3).
      const receipt = await this.storageReceipt(ref.storyId, ref.version);
      const tx = receipt?.arweave[ref.manifestSha256];
      if (!tx) throw e;
      bytes = await this.gateways.fetchBySha({ sha256: ref.manifestSha256, arweave: tx }, { maxBytes: MANIFEST_MAX });
    }
    const check = verifyManifest(bytes, ref, lists);
    if (check.checks.hash) await this.cacheManifest(ref.manifestSha256, bytes);
    return { check, bytes, fromCache: false };
  }

  /** Bytes of a manifest by hash (earlier versions); verified by `fetchBySha`. */
  async fetchManifestBytes(sha256: string, cid?: string, arweave?: string): Promise<Uint8Array> {
    const cached = await this.readCachedManifest(sha256);
    if (cached) return cached;
    const bytes = await this.gateways.fetchBySha({ cid, sha256, arweave }, { maxBytes: MANIFEST_MAX });
    await this.cacheManifest(sha256, bytes);
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

  /** Raw storage receipt events for a version (to include in offline bundles). */
  async storageReceiptEvents(storyId: string, version: number): Promise<Event[]> {
    const authors = this.publisherKeys();
    if (!authors.length || !this.lists) return [];
    const events = await this.pool
      .query(this.relayUrls(), { kinds: [KIND_APP_DATA], authors, "#d": [storageD(storyId, version)] })
      .catch(() => [] as Event[]);
    return events.filter((e) => parseStorageReceipt(e, this.lists!) !== null);
  }

  // ---------------------------------------------------------------- publishing

  publish(event: Event): Promise<PublishResult[]> {
    return this.pool.publish(this.relayUrls(), event);
  }

  /** The newest list event signed by `author` with this name (for read-modify-sign). */
  latestListEvent(author: string, name: string): Event | undefined {
    let best: Event | undefined;
    for (const e of this.listEvents.values()) {
      if (e.pubkey !== author || !e.tags.some((t) => t[0] === "d" && t[1] === listD(name as never))) continue;
      if (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id)) best = e;
    }
    return best;
  }

  /** Accept a list event we just signed (or imported from a bundle) so the UI reflects it immediately. */
  acceptListEvents(events: Event[]): void {
    if (this.addListEvents(events)) {
      this.rebuildLists();
      void this.store.set("lists:events", this.lists?.sourceEvents ?? []);
      this.emit();
    }
  }
}
