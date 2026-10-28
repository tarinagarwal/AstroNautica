/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Object keys are sorted by UTF-16 code units, there is no whitespace, strings use the JSON.stringify escaping
 * (which matches RFC 8785) and numbers use the ECMAScript Number-to-String conversion, which is what JCS specifies.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite numbers are not allowed");
      // JSON.stringify(-0) is "0", as JCS requires.
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",") + "]";
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareUtf16);
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default:
      throw new TypeError(`JCS: cannot canonicalize a value of type ${typeof value}`);
  }
}

function compareUtf16(a: string, b: string): number {
  // String comparison in JS is already by UTF-16 code units.
  return a < b ? -1 : a > b ? 1 : 0;
}
