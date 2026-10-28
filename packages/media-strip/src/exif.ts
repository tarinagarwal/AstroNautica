import { startsWith } from "./bytes.js";

/** What we need from an Exif/TIFF block: the orientation and whether it points to GPS data. */
export interface ExifSummary {
  orientation: number;
  hasGps: boolean;
}

const TAG_ORIENTATION = 0x0112;
const TAG_GPS_IFD = 0x8825;

/**
 * Reads IFD0 of a TIFF structure (the payload of a JPEG APP1 "Exif\0\0" segment after the six-byte header,
 * a PNG eXIf chunk, or a WebP EXIF chunk). Every offset is bounds-checked; anything unreadable yields
 * the defaults (orientation 1, no GPS).
 */
export function readTiff(tiff: Uint8Array): ExifSummary {
  const result: ExifSummary = { orientation: 1, hasGps: false };
  if (tiff.length < 8) return result;
  let le: boolean;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) le = true;
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) le = false;
  else return result;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, le) !== 42) return result;
  const ifd0 = view.getUint32(4, le);
  if (ifd0 < 8 || ifd0 + 2 > tiff.length) return result;
  const count = view.getUint16(ifd0, le);
  for (let i = 0; i < count; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = view.getUint16(e, le);
    const type = view.getUint16(e + 2, le);
    if (tag === TAG_ORIENTATION && type === 3) {
      const v = view.getUint16(e + 8, le);
      if (v >= 1 && v <= 8) result.orientation = v;
    } else if (tag === TAG_GPS_IFD) {
      const ptr = type === 3 ? view.getUint16(e + 8, le) : view.getUint32(e + 8, le);
      if (ptr >= 8 && ptr + 2 <= tiff.length && view.getUint16(ptr, le) > 0) result.hasGps = true;
    }
  }
  return result;
}

/** Strips the optional "Exif\0\0" prefix some writers put in front of the TIFF header (WebP, PNG eXIf). */
export function tiffFromExifPayload(payload: Uint8Array): Uint8Array {
  if (startsWith(payload, 0, "Exif") && payload[4] === 0 && payload[5] === 0) return payload.subarray(6);
  return payload;
}
