/** Verified bytes → object URLs, with a bounded cache so long stories don't hold every image in memory. */

const urls = new Map<string, { url: string; size: number }>();
let total = 0;
const MAX = 96 * 1024 * 1024;

export function sniffMime(b: Uint8Array): string {
  const s = (o: number, sig: number[]) => sig.every((v, i) => b[o + i] === v);
  if (s(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (s(0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (s(0, [0x52, 0x49, 0x46, 0x46]) && s(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (s(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (s(4, [0x66, 0x74, 0x79, 0x70])) return "video/mp4";
  if (s(0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return "application/octet-stream";
}

/** An object URL for verified bytes, cached by `key` (a hash or CID). */
export function objectUrlFor(key: string, bytes: Uint8Array, mime?: string): string {
  const hit = urls.get(key);
  if (hit) {
    urls.delete(key);
    urls.set(key, hit);
    return hit.url;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime ?? sniffMime(bytes) }));
  urls.set(key, { url, size: bytes.length });
  total += bytes.length;
  while (total > MAX && urls.size > 1) {
    const [k, v] = urls.entries().next().value as [string, { url: string; size: number }];
    URL.revokeObjectURL(v.url);
    urls.delete(k);
    total -= v.size;
  }
  return url;
}

export function cachedObjectUrl(key: string): string | undefined {
  return urls.get(key)?.url;
}
