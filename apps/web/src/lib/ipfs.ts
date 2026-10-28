/**
 * Trustless IPFS reads: fetch raw blocks from any gateway (`?format=raw`), check each block against the hash inside
 * its CID, and rebuild files and directory paths from the verified blocks (dag-pb + UnixFS). No gateway has to be
 * trusted: a block whose bytes don't hash to its CID is rejected and the gateway is flagged (spec §8).
 */
import { sha256 } from "@noble/hashes/sha2.js";

export const CODEC_RAW = 0x55;
export const CODEC_DAG_PB = 0x70;
const MH_SHA256 = 0x12;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("invalid base32");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++]!;
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [value, pos];
    shift += 7;
    if (shift > 49) throw new Error("varint too long");
  }
}

export function writeVarint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

export interface Cid {
  version: 0 | 1;
  codec: number;
  /** SHA-256 digest the block must hash to. */
  digest: Uint8Array;
  /** Canonical CIDv1 base32 string (what we ask gateways for). */
  string: string;
}

function fromMultihash(version: 0 | 1, codec: number, mh: Uint8Array, at: number): Cid {
  const [code, p1] = readVarint(mh, at);
  const [len, p2] = readVarint(mh, p1);
  if (code !== MH_SHA256 || len !== 32) throw new Error("only sha2-256 CIDs are supported");
  const digest = mh.slice(p2, p2 + 32);
  if (digest.length !== 32) throw new Error("truncated multihash");
  const bin = Uint8Array.from([1, ...writeVarint(codec), MH_SHA256, 32, ...digest]);
  return { version, codec, digest, string: "b" + base32Encode(bin) };
}

/** Parse a CIDv1 string (base32, multibase prefix "b"). */
export function parseCid(s: string): Cid {
  if (!/^b[a-z2-7]+$/.test(s)) throw new Error(`unsupported CID: ${s}`);
  return parseCidBytes(base32Decode(s.slice(1)));
}

/** Parse a binary CID as found in dag-pb links (CIDv0 multihash or CIDv1). */
export function parseCidBytes(b: Uint8Array): Cid {
  if (b[0] === MH_SHA256 && b[1] === 32) return fromMultihash(0, CODEC_DAG_PB, b, 0);
  const [version, p1] = readVarint(b, 0);
  if (version !== 1) throw new Error("unsupported CID version");
  const [codec, p2] = readVarint(b, p1);
  if (codec !== CODEC_RAW && codec !== CODEC_DAG_PB) throw new Error(`unsupported codec 0x${codec.toString(16)}`);
  return fromMultihash(1, codec, b, p2);
}

export function blockMatches(cid: Cid, bytes: Uint8Array): boolean {
  const d = sha256(bytes);
  if (d.length !== cid.digest.length) return false;
  let diff = 0;
  for (let i = 0; i < d.length; i++) diff |= d[i]! ^ cid.digest[i]!;
  return diff === 0;
}

// ---- dag-pb / UnixFS decoding (protobuf, only the fields we need) ----

export interface PbLink {
  cid: Cid;
  name: string;
  size: number;
}

export interface PbNode {
  links: PbLink[];
  data?: Uint8Array;
}

function* fields(buf: Uint8Array): Generator<{ field: number; wire: number; value: number | Uint8Array }> {
  let pos = 0;
  while (pos < buf.length) {
    const [key, p] = readVarint(buf, pos);
    pos = p;
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      yield { field, wire, value: v };
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      if (p2 + len > buf.length) throw new Error("truncated protobuf field");
      yield { field, wire, value: buf.subarray(p2, p2 + len) };
      pos = p2 + len;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

export function decodePbNode(bytes: Uint8Array): PbNode {
  const node: PbNode = { links: [] };
  for (const f of fields(bytes)) {
    if (f.field === 1 && f.wire === 2) node.data = f.value as Uint8Array;
    if (f.field === 2 && f.wire === 2) {
      let cid: Cid | undefined;
      let name = "";
      let size = 0;
      for (const g of fields(f.value as Uint8Array)) {
        if (g.field === 1 && g.wire === 2) cid = parseCidBytes(g.value as Uint8Array);
        if (g.field === 2 && g.wire === 2) name = new TextDecoder().decode(g.value as Uint8Array);
        if (g.field === 3 && g.wire === 0) size = g.value as number;
      }
      if (!cid) throw new Error("dag-pb link without a hash");
      node.links.push({ cid, name, size });
    }
  }
  return node;
}

export const UNIXFS = { raw: 0, directory: 1, file: 2, metadata: 3, symlink: 4, hamt: 5 } as const;

export interface UnixFsData {
  type: number;
  data?: Uint8Array;
}

export function decodeUnixFs(bytes: Uint8Array | undefined): UnixFsData {
  if (!bytes) throw new Error("dag-pb node without UnixFS data");
  const out: UnixFsData = { type: -1 };
  for (const f of fields(bytes)) {
    if (f.field === 1 && f.wire === 0) out.type = f.value as number;
    if (f.field === 2 && f.wire === 2) out.data = f.value as Uint8Array;
  }
  return out;
}

// ---- Fetching ----

export interface BlockSource {
  /** Gateway base URLs in preferred order (already ranked by the caller's scoreboard). */
  gateways: () => string[];
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Skip the in-memory block cache (live checks in the Verify panel). */
  noCache?: boolean;
  /** Called for every attempt, so the caller can keep a scoreboard and flag gateways that serve wrong bytes. */
  onReport?: (r: {
    base: string;
    url: string;
    ok: boolean;
    reason?: "mismatch" | "http" | "timeout" | "network";
    ms: number;
  }) => void;
}

export class BlockFetchError extends Error {
  constructor(readonly cid: string) {
    super(`no gateway served a verified block for ${cid}`);
    this.name = "BlockFetchError";
  }
}

/** A small in-memory LRU of verified blocks, so directory nodes are not refetched for every HLS segment. */
class BlockCache {
  private readonly map = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  get(k: string): Uint8Array | undefined {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: Uint8Array): void {
    if (this.map.has(k)) return;
    this.map.set(k, v);
    this.bytes += v.length;
    while (this.bytes > this.maxBytes) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.length;
      this.map.delete(first);
    }
  }
}

const cache = new BlockCache(48 * 1024 * 1024);

/** Fetch one block by CID from the first gateway that serves bytes matching the CID's hash. */
export async function fetchBlock(cid: Cid, src: BlockSource): Promise<Uint8Array> {
  const hit = src.noCache ? undefined : cache.get(cid.string);
  if (hit) return hit;
  const doFetch = src.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  for (const base of src.gateways()) {
    const url = `${base.replace(/\/+$/, "")}/ipfs/${cid.string}?format=raw`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), src.timeoutMs ?? 15_000);
    const t0 = Date.now();
    try {
      const res = await doFetch(url, { signal: ctl.signal, headers: { Accept: "application/vnd.ipld.raw" } });
      if (!res.ok) {
        src.onReport?.({ base, url, ok: false, reason: "http", ms: Date.now() - t0 });
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!blockMatches(cid, bytes)) {
        src.onReport?.({ base, url, ok: false, reason: "mismatch", ms: Date.now() - t0 });
        continue;
      }
      src.onReport?.({ base, url, ok: true, ms: Date.now() - t0 });
      cache.set(cid.string, bytes);
      return bytes;
    } catch {
      src.onReport?.({ base, url, ok: false, reason: ctl.signal.aborted ? "timeout" : "network", ms: Date.now() - t0 });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BlockFetchError(cid.string);
}

/** Fetch and reassemble a whole file by CID, verifying every block. */
export async function fetchFileByCid(
  cid: Cid | string,
  src: BlockSource,
  maxBytes = 512 * 1024 * 1024,
): Promise<Uint8Array> {
  const root = typeof cid === "string" ? parseCid(cid) : cid;
  let total = 0;
  const count = (b: Uint8Array) => {
    total += b.length;
    if (total > maxBytes) throw new Error("file too large");
    return b;
  };
  const walk = async (c: Cid): Promise<Uint8Array[]> => {
    const block = await fetchBlock(c, src);
    if (c.codec === CODEC_RAW) return [count(block)];
    const node = decodePbNode(block);
    const fs = decodeUnixFs(node.data);
    if (fs.type !== UNIXFS.file && fs.type !== UNIXFS.raw) throw new Error(`${c.string} is not a file`);
    const out: Uint8Array[] = fs.data && fs.data.length ? [count(fs.data)] : [];
    // Fetch children a few at a time, keeping their order.
    const width = 4;
    for (let i = 0; i < node.links.length; i += width) {
      const groups = await Promise.all(node.links.slice(i, i + width).map((l) => walk(l.cid)));
      for (const g of groups) out.push(...g);
    }
    return out;
  };
  const parts = await walk(root);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Resolve `root/path/to/file` to the file's CID by walking verified directory blocks (plain and HAMT-sharded). */
export async function resolvePath(root: Cid | string, path: string, src: BlockSource): Promise<Cid> {
  let cur = typeof root === "string" ? parseCid(root) : root;
  for (const segment of path.split("/").filter(Boolean)) {
    const name = decodeURIComponent(segment);
    if (cur.codec !== CODEC_DAG_PB) throw new Error(`cannot descend into a raw block for "${name}"`);
    const next = await findInDirectory(cur, name, src);
    if (!next) throw new Error(`"${name}" not found`);
    cur = next;
  }
  return cur;
}

async function findInDirectory(dir: Cid, name: string, src: BlockSource): Promise<Cid | undefined> {
  const node = decodePbNode(await fetchBlock(dir, src));
  const fs = decodeUnixFs(node.data);
  if (fs.type === UNIXFS.directory) return node.links.find((l) => l.name === name)?.cid;
  if (fs.type === UNIXFS.hamt) {
    // Linear search over the shard: entries are "<2 hex chars><name>", sub-shards are just "<2 hex chars>".
    for (const l of node.links) {
      if (l.name.length > 2 && l.name.slice(2) === name) return l.cid;
    }
    for (const l of node.links) {
      if (l.name.length === 2) {
        const found = await findInDirectory(l.cid, name, src);
        if (found) return found;
      }
    }
    return undefined;
  }
  throw new Error(`${dir.string} is not a directory`);
}

/** Fetch `cid` or `cid/path` (as used by video `hls` fields), verified block by block. */
export async function fetchIpfsPath(ipfsPath: string, src: BlockSource, maxBytes?: number): Promise<Uint8Array> {
  const [root, ...rest] = ipfsPath.replace(/^\/?ipfs\//, "").split("/");
  const cid = rest.length ? await resolvePath(root!, rest.join("/"), src) : parseCid(root!);
  return fetchFileByCid(cid, src, maxBytes);
}
