/**
 * Test-only UnixFS encoder producing real CIDv1 blocks (raw leaves, 256 KiB chunks, dag-pb files and directories),
 * the same shapes Kubo produces with `--cid-version 1`. Used by unit tests and the e2e mock gateway.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { CODEC_DAG_PB, CODEC_RAW, base32Decode, base32Encode, writeVarint } from "../lib/ipfs.js";

export interface Block {
  cid: string;
  bytes: Uint8Array;
}

export interface Encoded {
  cid: string;
  /** Cumulative size of the DAG (for parent links). */
  size: number;
  blocks: Block[];
}

const CHUNK = 256 * 1024;

function cidBytes(codec: number, bytes: Uint8Array): Uint8Array {
  return Uint8Array.from([1, ...writeVarint(codec), 0x12, 32, ...sha256(bytes)]);
}

function cidString(codec: number, bytes: Uint8Array): { str: string; bin: Uint8Array } {
  const bin = cidBytes(codec, bytes);
  return { str: "b" + base32Encode(bin), bin };
}

function field(n: number, wire: number): number[] {
  return writeVarint(n * 8 + wire);
}
function lenField(n: number, b: Uint8Array): number[] {
  return [...field(n, 2), ...writeVarint(b.length), ...b];
}
function intField(n: number, v: number): number[] {
  return [...field(n, 0), ...writeVarint(v)];
}

function unixfs(type: number, data?: Uint8Array, filesize?: number, blocksizes: number[] = []): Uint8Array {
  const out = [...intField(1, type)];
  if (data && data.length) out.push(...lenField(2, data));
  if (filesize !== undefined) out.push(...intField(3, filesize));
  for (const b of blocksizes) out.push(...intField(4, b));
  return Uint8Array.from(out);
}

function pbNode(links: { bin: Uint8Array; name: string; size: number }[], data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const l of links) {
    const link = [...lenField(1, l.bin), ...lenField(2, new TextEncoder().encode(l.name)), ...intField(3, l.size)];
    out.push(...lenField(2, Uint8Array.from(link)));
  }
  out.push(...lenField(1, data));
  return Uint8Array.from(out);
}

export function encodeFile(bytes: Uint8Array, chunk = CHUNK): Encoded {
  if (bytes.length <= chunk) {
    const { str } = cidString(CODEC_RAW, bytes);
    return { cid: str, size: bytes.length, blocks: [{ cid: str, bytes }] };
  }
  const leaves: { bin: Uint8Array; name: string; size: number; block: Block }[] = [];
  for (let off = 0; off < bytes.length; off += chunk) {
    const b = bytes.slice(off, off + chunk);
    const { str, bin } = cidString(CODEC_RAW, b);
    leaves.push({ bin, name: "", size: b.length, block: { cid: str, bytes: b } });
  }
  if (leaves.length > 174) throw new Error("test encoder supports files up to 174 chunks");
  const node = pbNode(
    leaves,
    unixfs(
      2,
      undefined,
      bytes.length,
      leaves.map((l) => l.size),
    ),
  );
  const { str } = cidString(CODEC_DAG_PB, node);
  return {
    cid: str,
    size: node.length + leaves.reduce((n, l) => n + l.size, 0),
    blocks: [{ cid: str, bytes: node }, ...leaves.map((l) => l.block)],
  };
}

/** Encode a directory tree: values are file bytes or nested directories. */
export function encodeDirectory(entries: Record<string, Uint8Array | Record<string, unknown>>): Encoded {
  const children = Object.keys(entries)
    .sort()
    .map((name) => {
      const v = entries[name]!;
      const enc = ArrayBuffer.isView(v)
        ? encodeFile(v as Uint8Array)
        : encodeDirectory(v as Record<string, Uint8Array>);
      return { name, enc };
    });
  const links = children.map(({ name, enc }) => ({
    bin: base32Decode(enc.cid.slice(1)),
    name,
    size: enc.size,
  }));
  const node = pbNode(links, unixfs(1));
  const { str } = cidString(CODEC_DAG_PB, node);
  return {
    cid: str,
    size: node.length + children.reduce((n, c) => n + c.enc.size, 0),
    blocks: [{ cid: str, bytes: node }, ...children.flatMap((c) => c.enc.blocks)],
  };
}
