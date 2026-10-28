/** Messages between `image.ts` and `image-worker.ts`. Types only (erased at runtime). */
export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageJob {
  bytes: Uint8Array;
  widths: number[];
  maxPixels: number;
  /** Re-encode the original with its Exif orientation applied (when stripping would lose the rotation). */
  reencodeOriginalAs: ImageFormat | null;
}

export interface EncodedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface ImageJobResult {
  /** Dimensions after applying the Exif orientation. */
  width: number;
  height: number;
  variants: { key: number; image: EncodedImage }[];
  blurhash: string;
  original: EncodedImage | null;
}
