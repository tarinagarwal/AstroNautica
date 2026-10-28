/**
 * Blurhash placeholders without a native module: decode the hash to a small RGBA image and wrap it in an
 * uncompressed 24-bit BMP data URI, which the platform image view can show directly (scaled up and blurred).
 */
import { decode, isBlurhashValid } from "blurhash";
import { bytesToBase64 } from "./bytes";

export function rgbaToBmp(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const out = new Uint8Array(54 + pixelBytes);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, -height, true); // top-down rows
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, pixelBytes, true);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = 54 + y * rowSize + x * 3;
      out[d] = rgba[s + 2]!;
      out[d + 1] = rgba[s + 1]!;
      out[d + 2] = rgba[s]!;
    }
  }
  return out;
}

const cache = new Map<string, string>();

/** A data: URI for the blurhash, or undefined when the hash is invalid. */
export function blurhashDataUri(hash: string, width = 32, height = 32): string | undefined {
  const key = `${hash}|${width}x${height}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!isBlurhashValid(hash).result) return undefined;
  const uri = `data:image/bmp;base64,${bytesToBase64(rgbaToBmp(decode(hash, width, height), width, height))}`;
  if (cache.size > 200) cache.clear();
  cache.set(key, uri);
  return uri;
}
