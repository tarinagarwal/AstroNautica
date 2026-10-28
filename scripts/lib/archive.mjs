/**
 * Rebuild the public archive from public networks alone (spec §11). Used by `scripts/rebuild-archive.mjs` and by the
 * mirror kit's `services/mirror-sync`. See the CLI for the description of sources and checks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { CarBlockIterator } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 as mfSha256 } from "multiformats/hashes/sha2";
import { createPublicClient, http, parseAbiItem } from "viem";
import {
  buildEffectiveLists,
  fetchVerified,
  GatewayScoreboard,
  KIND_APP_DATA,
  KIND_STORY,
  parseStorageReceipt,
  KIND_COMMENT,
  KIND_REACTION,
  RelayPool,
  selectStories,
  verifyManifest,
  wasModeratorAt,
  wasPublisherAt,
  verifyApprovalSignature,
} from "@azaadawaaz/core";
import { bytes16ToStoryId, hexEquals, manifestSha256, sha256Hex, validateManifest } from "@azaadawaaz/schema";

/**
 * Fetch a CAR for `cid` from trustless gateways, verify every block against its hash and check the DAG is complete.
 * Returns the root CID and blocks (root block first).
 */
export async function fetchVerifiedCar(cid, ipfsGateways, board = new GatewayScoreboard()) {
  const root = CID.parse(cid);
  for (const gw of board.order(ipfsGateways, (g) => g)) {
    try {
      const res = await fetch(`${gw}/ipfs/${cid}?format=car&dag-scope=all`, {
        headers: { Accept: "application/vnd.ipld.car" },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blocks = new Map();
      const it = await CarBlockIterator.fromBytes(new Uint8Array(await res.arrayBuffer()));
      for await (const { cid: bc, bytes } of it) {
        if (bc.multihash.code !== mfSha256.code) throw new Error(`unsupported hash in block ${bc}`);
        const digest = await mfSha256.digest(bytes);
        if (!hexEquals(sha256Hex(digest.digest), sha256Hex(bc.multihash.digest))) {
          board.record(gw, { ok: false, reason: "mismatch", ms: 0, url: gw });
          throw new Error(`block ${bc} does not match its hash`);
        }
        blocks.set(bc.multihash.bytes.toString(), { cid: bc, bytes });
      }
      // Walk the DAG from the root: every linked block must be present.
      const stack = [root];
      const seen = new Set();
      while (stack.length) {
        const c = stack.pop();
        const k = c.multihash.bytes.toString();
        if (seen.has(k)) continue;
        seen.add(k);
        const b = blocks.get(k);
        if (!b) throw new Error(`CAR is missing block ${c}`);
        if (c.code === dagPb.code) for (const link of dagPb.decode(b.bytes).Links) stack.push(link.Hash);
      }
      board.record(gw, { ok: true, ms: 1, url: gw });
      return { root, blocks: [...blocks.values()], gateway: gw };
    } catch (e) {
      if (!String(e.message).includes("does not match"))
        board.record(gw, { ok: false, reason: "network", ms: 0, url: gw });
    }
  }
  throw new Error(`no gateway returned a complete, verified CAR for ${cid}`);
}

/** Bytes of a whole file from verified CAR blocks (UnixFS: concatenate leaf data in order). */
export function fileBytes(root, blocks) {
  const byKey = new Map(blocks.map((b) => [b.cid.multihash.bytes.toString(), b]));
  const out = [];
  const walk = (c) => {
    const b = byKey.get(c.multihash.bytes.toString());
    if (c.code === 0x55) return out.push(b.bytes); // raw leaf
    const node = dagPb.decode(b.bytes);
    if (node.Links.length === 0) {
      out.push(unixfsData(node.Data));
      return;
    }
    for (const l of node.Links) walk(l.Hash);
  };
  walk(root);
  const total = out.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of out) {
    buf.set(p, off);
    off += p.length;
  }
  return buf;
}

/** Extract the `Data` field (field 2) from a UnixFS protobuf message. */
function unixfsData(pb) {
  if (!pb) return new Uint8Array(0);
  let i = 0;
  const varint = () => {
    let x = 0,
      s = 0,
      b;
    do {
      b = pb[i++];
      x += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return x;
  };
  while (i < pb.length) {
    const key = varint();
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 2) {
      const len = varint();
      if (field === 2) return pb.subarray(i, i + len);
      i += len;
    } else if (wire === 0) varint();
    else break;
  }
  return new Uint8Array(0);
}

export async function importCarInto(blocks, pinTo) {
  if (!pinTo) return;
  // The first block is the root (fetchVerifiedCar puts it first).
  const { CarWriter } = await import("@ipld/car/writer");
  const { writer, out } = CarWriter.create([blocks[0].cid]);
  const chunks = [];
  const collect = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await collect;
  const form = new FormData();
  form.append("file", new Blob(chunks), "archive.car");
  const res = await fetch(`${pinTo.replace(/\/+$/, "")}/api/v0/dag/import?pin-roots=false`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`dag import failed: HTTP ${res.status} ${await res.text()}`);
}

export async function pinCid(cid, pinTo) {
  if (!pinTo) return;
  const res = await fetch(`${pinTo.replace(/\/+$/, "")}/api/v0/pin/add?arg=${cid}&recursive=true`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`pin failed: HTTP ${res.status} ${await res.text()}`);
}

/**
 * @param {object} o
 * @param {string} o.owner owner pubkey (hex)
 * @param {string[]} o.relays bootstrap relays
 * @param {string[]} o.gateways IPFS gateway base URLs
 * @param {string} [o.arweaveUrl]
 * @param {{key: string, rpc: string, registry: string, fromBlock?: number}[]} [o.chains]
 * @param {string} [o.pinTo] Kubo RPC URL to import and pin everything into
 * @param {string[]} [o.republishTo] relays to copy all events to
 * @param {string} [o.outDir] write manifests and files here
 * @param {boolean} [o.includeSocial] also copy comments and reactions when republishing
 * @param {object[]} [o.extraListEvents] previously verified list events (last good copy)
 * @param {(...a: unknown[]) => void} [o.say] progress logger
 */
export async function rebuildArchive(o) {
  const { owner, relays, gateways, arweaveUrl, pinTo, outDir } = o;
  const chains = o.chains ?? [];
  const republishTo = o.republishTo ?? [];
  const includeSocial = Boolean(o.includeSocial);
  const extraListEvents = o.extraListEvents ?? [];
  const say = o.say ?? (() => {});
  const report = { stories: 0, versions: 0, files: 0, problems: [] };
  const problem = (msg) => {
    report.problems.push(msg);
    say("  ✗", msg);
  };

  // ---------- lists and events from relays ----------
  const pool = new RelayPool({ websocketImplementation: WebSocket });
  const listEvents = [
    ...extraListEvents,
    ...(await pool.query(relays, { kinds: [KIND_APP_DATA], authors: [owner] }, 10000)),
  ];
  let lists = buildEffectiveLists(owner, listEvents);
  const allRelays = [...new Set([...relays, ...lists.relays.map((r) => r.url)])];
  const allMods = lists.moderators.map((m) => m.pubkey);
  if (allMods.length)
    listEvents.push(...(await pool.query(allRelays, { kinds: [KIND_APP_DATA], authors: allMods }, 10000)));
  lists = buildEffectiveLists(owner, listEvents);
  const publishers = lists.serviceKeys.filter((k) => k.role === "publisher").map((k) => k.pubkey);
  if (publishers.length === 0) throw new Error("no publisher keys found in the owner's service-keys list");
  const allGateways = [
    ...gateways.map((url) => ({ url, network: "ipfs", operator: "own" })),
    ...lists.gateways.filter((g) => !gateways.includes(g.url)),
    ...(arweaveUrl ? [{ url: arweaveUrl, network: "arweave", operator: "own" }] : []),
  ];
  const ipfsGateways = [
    ...new Set(allGateways.filter((g) => g.network === "ipfs").map((g) => g.url.replace(/\/+$/, ""))),
  ];
  say(
    `lists: ${lists.moderators.length} moderators, ${publishers.length} publisher keys, ${ipfsGateways.length} IPFS gateways`,
  );

  const storyEvents = await pool.query(allRelays, { kinds: [KIND_STORY], authors: publishers }, 15000);
  const receiptEvents = await pool.query(allRelays, { kinds: [KIND_APP_DATA], authors: publishers }, 15000);
  const receipts = new Map(); // manifest sha → receipt
  const arTx = new Map(); // file sha → arweave tx
  for (const e of receiptEvents) {
    const r = parseStorageReceipt(e, lists);
    if (!r) continue;
    receipts.set(r.manifestSha256, r);
    for (const [sha, tx] of Object.entries(r.arweave)) arTx.set(sha, tx);
  }
  const latest = selectStories(storyEvents, lists, { includeUnlisted: true });
  say(`relays: ${latest.length} stories (latest versions), ${receipts.size} storage receipts`);

  // ---------- every version from the chain registries ----------
  const versions = new Map(); // `${storyId}:${version}` → { storyId, version, sha, cid, chains: [] }
  const published = parseAbiItem(
    "event Published(bytes16 indexed storyId, uint32 version, bytes32 manifestSha256, string manifestCid, uint64 timestamp)",
  );
  for (const c of chains) {
    try {
      const client = createPublicClient({ transport: http(c.rpc, { timeout: 30000 }) });
      const logs = await client.getLogs({
        address: c.registry,
        event: published,
        fromBlock: BigInt(c.fromBlock ?? 0),
        toBlock: "latest",
      });
      for (const l of logs) {
        const storyId = bytes16ToStoryId(l.args.storyId);
        const key = `${storyId}:${l.args.version}`;
        const sha = l.args.manifestSha256.slice(2);
        const v = versions.get(key) ?? {
          storyId,
          version: Number(l.args.version),
          sha,
          cid: l.args.manifestCid,
          chains: [],
        };
        if (v.sha !== sha) problem(`chains disagree on ${key}: ${v.sha} vs ${sha} (${c.key})`);
        v.chains.push(c.key);
        versions.set(key, v);
      }
      say(`chain ${c.key}: ${logs.length} receipts`);
    } catch (e) {
      problem(`chain ${c.key} unreachable: ${e.message}`);
    }
  }
  for (const s of latest) {
    const key = `${s.storyId}:${s.version}`;
    const v = versions.get(key);
    if (v && v.sha !== s.manifestSha256) problem(`relay event and chain disagree on ${key}`);
    if (!v)
      versions.set(key, {
        storyId: s.storyId,
        version: s.version,
        sha: s.manifestSha256,
        cid: s.manifestCid,
        chains: [],
      });
  }

  // ---------- fetching ----------
  const board = new GatewayScoreboard();

  const fetchCar = (cid) => fetchVerifiedCar(cid, ipfsGateways, board);
  const importCar = (blocks) => importCarInto(blocks, pinTo);
  const pinRoot = (cid) => pinCid(cid, pinTo);

  /** Fetch one content-addressed object (file or directory); verify; optionally pin; return file bytes when asked. */
  async function restore(cid, expectSha, label, wantBytes = false) {
    try {
      const { root, blocks } = await fetchCar(cid);
      await importCar([
        blocks.find((b) => b.cid.equals(root)) ?? blocks[0],
        ...blocks.filter((b) => !b.cid.equals(root)),
      ]);
      await pinRoot(cid);
      let bytes;
      if (expectSha || wantBytes) {
        bytes = fileBytes(root, blocks);
        if (expectSha && !hexEquals(sha256Hex(bytes), expectSha))
          throw new Error(`content of ${cid} does not match sha256`);
      }
      report.files++;
      if (outDir && bytes) {
        mkdirSync(join(outDir, "files"), { recursive: true });
        writeFileSync(join(outDir, "files", expectSha ?? cid), bytes);
      }
      return bytes;
    } catch (e) {
      // Fall back to Arweave for files we know the hash of.
      if (expectSha && arTx.has(expectSha) && arweaveUrl) {
        try {
          const bytes = await fetchVerified({
            sources: [{ base: arweaveUrl, url: `${arweaveUrl.replace(/\/+$/, "")}/${arTx.get(expectSha)}` }],
            sha256: expectSha,
            maxBytes: 3 * 1024 * 1024 * 1024,
          });
          report.files++;
          if (outDir) {
            mkdirSync(join(outDir, "files"), { recursive: true });
            writeFileSync(join(outDir, "files", expectSha), bytes);
          }
          if (pinTo) {
            const form = new FormData();
            form.append("file", new Blob([bytes]));
            const r = await fetch(`${pinTo}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, {
              method: "POST",
              body: form,
            });
            const added = JSON.parse((await r.text()).trim().split("\n").pop());
            if (added.Hash !== cid)
              problem(`${label}: re-added from Arweave but CID differs (${added.Hash} vs ${cid})`);
          }
          return bytes;
        } catch (e2) {
          problem(`${label}: IPFS failed (${e.message}) and Arweave failed (${e2.message})`);
          return undefined;
        }
      }
      problem(`${label}: ${e.message}`);
      return undefined;
    }
  }

  // ---------- rebuild every version ----------
  const sorted = [...versions.values()].sort((a, b) => a.storyId.localeCompare(b.storyId) || a.version - b.version);
  const storiesSeen = new Set();
  for (const v of sorted) {
    const label = `${v.storyId} v${v.version}`;
    say(`• ${label}`);
    const bytes = await restore(v.cid, v.sha, `${label} manifest`, true);
    if (!bytes) continue;
    let m;
    try {
      m = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      problem(`${label}: manifest is not JSON`);
      continue;
    }
    const ref = latest.find((s) => s.storyId === v.storyId && s.version === v.version);
    if (ref) {
      const check = verifyManifest(bytes, ref, lists);
      if (!check.ok) problem(`${label}: manifest verification failed: ${check.errors.join("; ")}`);
    } else {
      // Superseded versions: no relay event, so check everything except the event binding.
      const val = validateManifest(m);
      if (!val.ok) problem(`${label}: invalid manifest: ${val.errors.join("; ")}`);
      else {
        if (!hexEquals(manifestSha256(m), v.sha)) problem(`${label}: manifest is not canonical`);
        if (m.id !== v.storyId || m.version !== v.version) problem(`${label}: id/version mismatch`);
        if (!verifyApprovalSignature(m, m.approval)) problem(`${label}: approval signature invalid`);
        if (!wasModeratorAt(lists, m.approval.moderator, Date.parse(m.approval.approvedAt) / 1000))
          problem(`${label}: approver was not a moderator at the time`);
        if (!wasPublisherAt(lists, m.publisher, Date.parse(m.publishedAt) / 1000))
          problem(`${label}: publisher key not valid then`);
      }
    }
    if (outDir) {
      mkdirSync(join(outDir, "manifests"), { recursive: true });
      writeFileSync(join(outDir, "manifests", `${v.storyId}.v${v.version}.json`), bytes);
    }
    // Every referenced file.
    const items = [];
    if (m.cover)
      items.push(
        ["cover", m.cover.cid, m.cover.sha256],
        ...Object.entries(m.cover.variants ?? {}).map(([w, c]) => [`cover ${w}`, c]),
      );
    for (const b of m.blocks ?? []) {
      if (b.type === "image")
        for (const i of b.items) {
          items.push(["image", i.cid, i.sha256]);
          for (const [w, c] of Object.entries(i.variants ?? {})) items.push([`image ${w}`, c]);
        }
      if (b.type === "video") {
        items.push(
          ["video mp4", b.mp4.cid, b.mp4.sha256],
          ["poster", b.poster.cid, b.poster.sha256],
          ["hls", b.hls.split("/")[0]],
        );
        if (b.preview) items.push(["preview", b.preview.cid, b.preview.sha256]);
      }
    }
    const done = new Set();
    for (const [what, cid, sha] of items) {
      if (done.has(cid)) continue;
      done.add(cid);
      await restore(cid, sha, `${label} ${what}`);
    }
    report.versions++;
    storiesSeen.add(v.storyId);
  }
  report.stories = storiesSeen.size;

  // ---------- republish events ----------
  if (republishTo.length) {
    const evs = [
      ...lists.sourceEvents,
      ...latest.map((s) => s.event),
      ...receiptEvents.filter((e) => parseStorageReceipt(e, lists)),
    ];
    if (includeSocial && latest.length) {
      const addrs = latest.map((s) => s.address);
      for (let i = 0; i < addrs.length; i += 50) {
        const chunk = addrs.slice(i, i + 50);
        evs.push(...(await pool.query(allRelays, { kinds: [KIND_COMMENT], "#A": chunk }, 15000)));
        evs.push(...(await pool.query(allRelays, { kinds: [KIND_REACTION], "#a": chunk }, 15000)));
      }
    }
    let ok = 0;
    for (const e of evs) if ((await pool.publish(republishTo, e, 8000)).some((r) => r.ok)) ok++;
    say(`republished ${ok}/${evs.length} events to ${republishTo.length} relays`);
    if (ok < evs.length) problem(`only ${ok}/${evs.length} events republished`);
  }
  pool.close();
  return { ...report, lists };
}
