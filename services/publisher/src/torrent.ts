import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import createTorrent from "create-torrent";
import { encode as encodeMagnet } from "magnet-uri";
import { sha256Hex } from "@azaadawaaz/schema";
import { createHash } from "node:crypto";

export interface TorrentFile {
  /** Path inside the torrent, e.g. "video.mp4" or "hls/720p_000.ts". */
  path: string;
  content: Uint8Array;
}

export interface TorrentResult {
  infoHash: string;
  magnet: string;
  torrentPath: string;
  torrentSha256: string;
}

/**
 * Create a torrent for a video (the MP4 and its HLS folder) with IPFS gateway URLs as BEP-19 web seeds, and drop it
 * plus its files into the seed box's watch directory (spec §6 step 5).
 */
export async function createVideoTorrent(args: {
  name: string;
  files: TorrentFile[];
  /** Web seed base URLs: each must serve the torrent's files below it, e.g. `https://gw/ipfs/<dirCid>/`. */
  webSeeds: string[];
  seedDir: string;
  /** Where the seed box picks up .torrent files (default: seedDir). Written last, after the data is in place. */
  watchDir?: string;
}): Promise<TorrentResult> {
  const root = join(args.seedDir, args.name);
  mkdirSync(root, { recursive: true });
  const inputs = args.files.map((f) => {
    const full = join(root, f.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, f.content);
    return full;
  });
  const torrent: Buffer = await new Promise((resolve, reject) =>
    createTorrent(
      inputs,
      {
        name: args.name,
        createdBy: "AzaadAwaaz",
        // A fixed creation date keeps the infohash deterministic across retries.
        creationDate: 0,
        private: false,
        urlList: args.webSeeds,
        announceList: [
          ["udp://tracker.opentrackr.org:1337/announce"],
          ["udp://open.demonii.com:1337/announce"],
          ["wss://tracker.openwebtorrent.com"],
        ],
      } as never,
      (err: Error | null, t: Buffer) => (err ? reject(err) : resolve(t)),
    ),
  );
  const watch = args.watchDir ?? args.seedDir;
  mkdirSync(watch, { recursive: true });
  const torrentPath = join(watch, `${args.name}.torrent`);
  // The seed box (uid 1000) must be able to read it; write atomically so it never sees a partial file.
  writeFileSync(`${torrentPath}.part`, torrent, { mode: 0o644 });
  renameSync(`${torrentPath}.part`, torrentPath);
  const infoHash = infoHashOf(torrent);
  const uri = encodeMagnet({
    xt: `urn:btih:${infoHash}`,
    dn: args.name,
    ws: args.webSeeds,
    tr: ["udp://tracker.opentrackr.org:1337/announce", "wss://tracker.openwebtorrent.com"],
  } as never);
  return { infoHash, magnet: uri, torrentPath, torrentSha256: sha256Hex(new Uint8Array(torrent)) };
}

/** SHA-1 of the bencoded `info` dictionary. */
function infoHashOf(torrent: Buffer): string {
  const start = torrent.indexOf("4:info") + "4:info".length;
  const end = bencodeEnd(torrent, start);
  return createHash("sha1").update(torrent.subarray(start, end)).digest("hex");
}

function bencodeEnd(b: Buffer, i: number): number {
  const c = String.fromCharCode(b[i]!);
  if (c === "i") return b.indexOf("e", i) + 1;
  if (c === "l" || c === "d") {
    i++;
    while (String.fromCharCode(b[i]!) !== "e") i = bencodeEnd(b, i);
    return i + 1;
  }
  const colon = b.indexOf(":", i);
  return colon + 1 + Number(b.subarray(i, colon).toString());
}
