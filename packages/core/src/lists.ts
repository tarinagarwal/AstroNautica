import { finalizeEvent, type Event } from "nostr-tools/pure";
import {
  KIND_APP_DATA,
  LIST_D_PREFIX,
  MODERATOR_LISTS,
  OWNER_LISTS,
  listD,
  type ListName,
  type ModeratorListName,
  type OwnerListName,
} from "./kinds.js";
import { toPubkeyHex, verifyEventStrict } from "./keys.js";

export const LIST_SCHEMA = "azaadawaaz/list@1" as const;

// ---- Owner-signed list item types ----

export interface ModeratorEntry {
  pubkey: string; // hex
  /** X25519 public key (hex) for staging encryption. */
  x25519: string;
  name?: string;
  /** Unix seconds from which this moderator's approvals and list entries count. */
  from: number;
  /** Set when the moderator is removed; approvals made before this stay valid. */
  until?: number;
}

export interface ServiceKeyEntry {
  role: "publisher" | "owner";
  /** Nostr pubkey (hex). For role "owner" this is the pinned owner key itself. */
  pubkey: string;
  x25519?: string;
  evm?: string;
  from: number;
  until?: number;
}

export interface RelayEntry {
  url: string;
  operator: "own" | "public";
  country?: string;
}

export interface GatewayEntry {
  /** Base URL; files are fetched from `${url}/ipfs/<cid>` or `${url}/<arweave tx>`. */
  url: string;
  network: "ipfs" | "arweave";
  operator: "own" | "pinning" | "public";
}

export interface MirrorEntry {
  url: string;
}

export interface OnionEntry {
  address: string;
}

export interface ReleaseEntry {
  platform: "android";
  version: string;
  versionCode: number;
  sha256: string;
  size: number;
  urls: string[];
  /** SHA-256 of the APK signing certificate. */
  signingCertSha256: string;
  notes?: { en?: string; hi?: string };
}

export interface OverrideEntry {
  list: ModeratorListName;
  value: string;
}

export interface OwnerListItems {
  moderators: ModeratorEntry[];
  "service-keys": ServiceKeyEntry[];
  relays: RelayEntry[];
  gateways: GatewayEntry[];
  mirrors: MirrorEntry[];
  onions: OnionEntry[];
  releases: ReleaseEntry[];
  overrides: OverrideEntry[];
}

/** A moderator-tier entry: the value (story id, event id or pubkey) and when it was added (unix seconds). */
export type ModeratorListItem = [value: string, addedAt: number];

export interface ListContent<T> {
  schema: typeof LIST_SCHEMA;
  name: ListName;
  items: T[];
}

/** Build and sign a list event. */
export function createListEvent<N extends ListName>(
  name: N,
  items: N extends OwnerListName ? OwnerListItems[N] : ModeratorListItem[],
  secretKey: Uint8Array,
  createdAt: number = Math.floor(Date.now() / 1000),
): Event {
  const content: ListContent<unknown> = { schema: LIST_SCHEMA, name, items: items as unknown[] };
  return finalizeEvent(
    { kind: KIND_APP_DATA, created_at: createdAt, tags: [["d", listD(name)]], content: JSON.stringify(content) },
    secretKey,
  );
}

export interface ParsedList<T = unknown> {
  name: ListName;
  author: string;
  createdAt: number;
  items: T[];
  event: Event;
}

/** Verify signature and shape of a list event. Returns null for anything invalid. */
export function parseListEvent(event: Event, now: number = Math.floor(Date.now() / 1000)): ParsedList | null {
  if (!event || event.kind !== KIND_APP_DATA) return null;
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (!d || !d.startsWith(LIST_D_PREFIX)) return null;
  const name = d.slice(LIST_D_PREFIX.length) as ListName;
  if (!(OWNER_LISTS as readonly string[]).includes(name) && !(MODERATOR_LISTS as readonly string[]).includes(name))
    return null;
  // Events dated far in the future would win replaceable-event selection forever.
  if (event.created_at > now + 600) return null;
  if (!verifyEventStrict(event)) return null;
  let content: ListContent<unknown>;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (content?.schema !== LIST_SCHEMA || content.name !== name || !Array.isArray(content.items)) return null;
  const items = content.items.filter((i) => isValidItem(name, i));
  return { name, author: event.pubkey, createdAt: event.created_at, items, event };
}

const HEX32 = /^[0-9a-f]{64}$/;
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length < 2048;
const isTime = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
const isUrl = (x: unknown, schemes: string[]) => {
  if (!isStr(x)) return false;
  try {
    return schemes.includes(new URL(x).protocol);
  } catch {
    return false;
  }
};

function isValidItem(name: ListName, i: any): boolean {
  if ((MODERATOR_LISTS as readonly string[]).includes(name)) {
    return Array.isArray(i) && i.length === 2 && isStr(i[0]) && isTime(i[1]);
  }
  if (typeof i !== "object" || i === null) return false;
  switch (name as OwnerListName) {
    case "moderators":
      return (
        HEX32.test(i.pubkey) && HEX32.test(i.x25519) && isTime(i.from) && (i.until === undefined || isTime(i.until))
      );
    case "service-keys":
      return (
        (i.role === "publisher" || i.role === "owner") &&
        HEX32.test(i.pubkey) &&
        (i.x25519 === undefined || HEX32.test(i.x25519)) &&
        (i.evm === undefined || /^0x[0-9a-fA-F]{40}$/.test(i.evm)) &&
        isTime(i.from) &&
        (i.until === undefined || isTime(i.until))
      );
    case "relays":
      return isUrl(i.url, ["wss:", "ws:"]) && (i.operator === "own" || i.operator === "public");
    case "gateways":
      return (
        isUrl(i.url, ["https:", "http:"]) &&
        (i.network === "ipfs" || i.network === "arweave") &&
        ["own", "pinning", "public"].includes(i.operator)
      );
    case "mirrors":
      return isUrl(i.url, ["https:", "http:"]);
    case "onions":
      return isStr(i.address) && /^[a-z2-7]{56}\.onion$/.test(i.address);
    case "releases":
      return (
        i.platform === "android" &&
        isStr(i.version) &&
        Number.isInteger(i.versionCode) &&
        HEX32.test(i.sha256) &&
        Number.isInteger(i.size) &&
        Array.isArray(i.urls) &&
        i.urls.every((u: unknown) => isUrl(u, ["https:", "http:"])) &&
        HEX32.test(i.signingCertSha256)
      );
    case "overrides":
      return (MODERATOR_LISTS as readonly string[]).includes(i.list) && isStr(i.value);
  }
}

/** Replaceable-event selection: newest wins; ties go to the lowest event id (NIP-01). */
function newer(a: ParsedList, b: ParsedList | undefined): boolean {
  if (!b) return true;
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.event.id < b.event.id);
}

export interface DailyCaps {
  /** Max entries a single moderator may add per 24 h to a list before the excess is ignored by clients. */
  [list: string]: number;
}

export const DEFAULT_DAILY_CAPS: DailyCaps = {
  unlisted: 20,
  hidden: 500,
  muted: 200,
  featured: 50,
  "revoked-contributors": 50,
};

export interface EffectiveLists {
  owner: string;
  /** Latest owner-signed lists. Empty arrays when a list was never found. */
  moderators: ModeratorEntry[];
  serviceKeys: ServiceKeyEntry[];
  relays: RelayEntry[];
  gateways: GatewayEntry[];
  mirrors: MirrorEntry[];
  onions: OnionEntry[];
  releases: ReleaseEntry[];
  overrides: OverrideEntry[];
  /** Moderators active right now (no `until`, or `until` in the future). */
  activeModerators: Set<string>;
  /** Effective contributor set: union of contributors minus revocations, both after overrides. */
  contributors: Set<string>;
  revokedContributors: Set<string>;
  unlisted: Set<string>;
  hidden: Set<string>;
  muted: Set<string>;
  featured: Set<string>;
  /** Which signer put each unlisted/hidden entry there (for audit display). */
  provenance: Map<string, string[]>;
  /** The newest event used for each (author, list); useful for re-broadcasting to other relays. */
  sourceEvents: Event[];
}

/**
 * Combine list events from any number of sources into the effective lists (spec §3, decision D5).
 *
 * - Owner lists: the newest valid event signed by the owner.
 * - Moderator lists: the newest event per (signer, list) for the owner and each active moderator, unioned, minus the
 *   owner's overrides. Entries from removed moderators no longer count. A non-owner moderator's entries beyond the
 *   daily cap are ignored (newest first dropped), limiting what a compromised moderator can do before removal.
 */
export function buildEffectiveLists(
  ownerKey: string,
  events: Event[],
  opts: { now?: number; caps?: DailyCaps } = {},
): EffectiveLists {
  const owner = toPubkeyHex(ownerKey);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const caps = opts.caps ?? DEFAULT_DAILY_CAPS;

  const latest = new Map<string, ParsedList>(); // key: author|name
  for (const e of events) {
    const p = parseListEvent(e, now);
    if (!p) continue;
    const k = `${p.author}|${p.name}`;
    if (newer(p, latest.get(k))) latest.set(k, p);
  }
  const ownerList = <N extends OwnerListName>(n: N) => (latest.get(`${owner}|${n}`)?.items ?? []) as OwnerListItems[N];

  const moderators = ownerList("moderators");
  const activeModerators = new Set(
    moderators.filter((m) => m.from <= now && (m.until === undefined || m.until > now)).map((m) => m.pubkey),
  );
  activeModerators.delete(owner);
  const overrides = ownerList("overrides");
  const overridden = new Set(overrides.map((o) => `${o.list}|${o.value}`));

  const provenance = new Map<string, string[]>();
  const union = (name: ModeratorListName): Set<string> => {
    const out = new Set<string>();
    for (const signer of [owner, ...activeModerators]) {
      const p = latest.get(`${signer}|${name}`);
      if (!p) continue;
      let items = p.items as ModeratorListItem[];
      const cap = caps[name];
      if (signer !== owner && cap !== undefined) {
        const recent = items.filter(([, at]) => at > now - 86400).sort((a, b) => a[1] - b[1]);
        if (recent.length > cap) {
          const dropped = new Set(recent.slice(cap).map(([v]) => v));
          items = items.filter(([v, at]) => !(at > now - 86400 && dropped.has(v)));
        }
      }
      for (const [v] of items) {
        if (overridden.has(`${name}|${v}`)) continue;
        out.add(v);
        if (name === "unlisted" || name === "hidden" || name === "muted") {
          const k = `${name}|${v}`;
          provenance.set(k, [...(provenance.get(k) ?? []), signer]);
        }
      }
    }
    return out;
  };

  const revokedContributors = union("revoked-contributors");
  const contributors = union("contributors");
  for (const r of revokedContributors) contributors.delete(r);

  return {
    owner,
    moderators,
    serviceKeys: ownerList("service-keys"),
    relays: ownerList("relays"),
    gateways: ownerList("gateways"),
    mirrors: ownerList("mirrors"),
    onions: ownerList("onions"),
    releases: ownerList("releases"),
    overrides,
    activeModerators,
    contributors,
    revokedContributors,
    unlisted: union("unlisted"),
    hidden: union("hidden"),
    muted: union("muted"),
    featured: union("featured"),
    provenance,
    sourceEvents: [...latest.values()]
      .filter((p) => p.author === owner || activeModerators.has(p.author))
      .map((p) => p.event),
  };
}

/** Was `pubkey` a moderator at time `at` (unix seconds)? Used to check approvals, including old ones. */
export function wasModeratorAt(
  lists: Pick<EffectiveLists, "moderators" | "owner">,
  pubkey: string,
  at: number,
): boolean {
  const hex = toPubkeyHex(pubkey);
  if (hex === lists.owner) return true;
  return lists.moderators.some((m) => m.pubkey === hex && m.from <= at && (m.until === undefined || at < m.until));
}

/** Was `pubkey` a valid publisher key at time `at`? */
export function wasPublisherAt(lists: Pick<EffectiveLists, "serviceKeys">, pubkey: string, at: number): boolean {
  const hex = toPubkeyHex(pubkey);
  return lists.serviceKeys.some(
    (k) => k.role === "publisher" && k.pubkey === hex && k.from <= at && (k.until === undefined || at < k.until),
  );
}

/** The publisher entry valid right now (the newest `from` among unexpired entries). */
export function currentPublisher(lists: Pick<EffectiveLists, "serviceKeys">, now = Math.floor(Date.now() / 1000)) {
  return lists.serviceKeys
    .filter((k) => k.role === "publisher" && k.from <= now && (k.until === undefined || now < k.until))
    .sort((a, b) => b.from - a.from)[0];
}

/** Add or remove a value in a moderator-tier list, returning the new items (for re-signing). */
export function editModeratorList(
  items: ModeratorListItem[],
  op: "add" | "remove",
  value: string,
  now = Math.floor(Date.now() / 1000),
): ModeratorListItem[] {
  const rest = items.filter(([v]) => v !== value);
  return op === "add" ? [...rest, [value, now]] : rest;
}
