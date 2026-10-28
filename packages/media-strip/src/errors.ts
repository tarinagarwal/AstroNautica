/** Thrown for formats this package cannot strip losslessly (HEIC/HEIF, AVIF, GIF, unknown bytes, …). */
export class UnsupportedFormatError extends Error {
  /** The sniffed MIME type, or `null` when the bytes match no known format. */
  readonly mime: string | null;
  constructor(mime: string | null, message?: string) {
    super(
      message ??
        `Unsupported format for metadata stripping: ${mime ?? "unknown"}. Convert it to JPEG first (e.g. via a canvas) and strip that.`,
    );
    this.name = "UnsupportedFormatError";
    this.mime = mime;
  }
}

/**
 * Thrown when the file structure cannot be walked safely (lengths pointing past the end, broken markers).
 * The stripper refuses rather than emit a file that might still carry metadata.
 */
export class MalformedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedMediaError";
  }
}
