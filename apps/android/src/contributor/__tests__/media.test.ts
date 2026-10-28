import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { detectMime, findMetadata, stripMetadata } from "@azaadawaaz/media-strip";
import { nodeFs } from "../../test/nodePlatform";
import { joinPath } from "../../platform/types";
import { DEFAULT_MEDIA_LIMITS } from "../draft";
import { MediaError, prepareImage, prepareVideo, type MediaTools } from "../media";

const FIX = resolve(__dirname, "../../../../../packages/media-strip/test/fixtures");

/** Tools as on the phone, with the platform JPEG encoder replaced by a test encoder (media-strip's output). */
function tools(fs: ReturnType<typeof nodeFs>, log: string[]): MediaTools {
  return {
    importUri: async (uri, dest, max) => {
      const b = new Uint8Array(readFileSync(uri.replace("file://", "")));
      if (b.length > max) throw new Error("too large");
      await fs.writeBytes(dest, b);
      return { size: b.length, name: uri, mime: "" };
    },
    imageToJpeg: async (src, dest) => {
      log.push(src);
      const b = await fs.readBytes(src);
      const mime = detectMime(b);
      if (mime !== "image/jpeg") throw new Error("test encoder only re-encodes JPEG fixtures");
      await fs.writeBytes(dest, stripMetadata(b, mime, { keepIcc: false }));
      return { width: 1, height: 1 };
    },
  };
}

describe("on-device media preparation", () => {
  it("re-encodes JPEGs through the platform encoder and confirms nothing is left", async () => {
    const fs = nodeFs();
    const log: string[] = [];
    const m = await prepareImage(
      fs,
      tools(fs, log),
      `file://${FIX}/gps.jpg`,
      joinPath(fs.paths.files, "d"),
      DEFAULT_MEDIA_LIMITS,
    );
    expect(log).toHaveLength(1);
    expect(m.converted).toBe(true);
    expect(m.metadataFree).toBe(true);
    expect(m.removed).toEqual(expect.arrayContaining(["exif", "gps"]));
    const out = await fs.readBytes(m.path);
    expect(findMetadata(out, "image/jpeg")).toEqual([]);
    expect(createHash("sha256").update(out).digest("hex")).toBe(m.sha256);
    expect(m.path.endsWith(m.sha256)).toBe(true);
  });

  it("strips PNG and WebP losslessly, dropping the ICC profile too", async () => {
    const fs = nodeFs();
    for (const f of ["gps.png", "gps.webp"]) {
      const m = await prepareImage(
        fs,
        tools(fs, []),
        `file://${FIX}/${f}`,
        joinPath(fs.paths.files, "d"),
        DEFAULT_MEDIA_LIMITS,
      );
      expect(m.converted).toBe(false);
      expect(findMetadata(await fs.readBytes(m.path), m.mime)).toEqual([]);
      expect(m.removed).toContain("gps");
    }
  });

  it("refuses formats it cannot convert", async () => {
    const fs = nodeFs();
    await expect(
      prepareImage(fs, tools(fs, []), `file://${FIX}/sample.avif`, joinPath(fs.paths.files, "d"), DEFAULT_MEDIA_LIMITS),
    ).rejects.toThrow();
  });

  it("strips videos in place without re-encoding and re-checks the output", async () => {
    const fs = nodeFs();
    const m = await prepareVideo(
      fs,
      tools(fs, []),
      `file://${FIX}/phone.mov`,
      joinPath(fs.paths.files, "d"),
      DEFAULT_MEDIA_LIMITS,
    );
    expect(m.mime).toBe("video/quicktime");
    expect(m.metadataFree).toBe(true);
    expect(m.removed).toEqual(expect.arrayContaining(["mp4:location", "mp4:data-track"]));
    const out = await fs.readBytes(m.path);
    expect(findMetadata(out, "video/quicktime")).toEqual([]);
    expect(
      Buffer.from(out).equals(
        Buffer.from(stripMetadata(new Uint8Array(readFileSync(`${FIX}/phone.mov`)), "video/quicktime")),
      ),
    ).toBe(true);
    await expect(
      prepareVideo(fs, tools(fs, []), `file://${FIX}/gps.jpg`, joinPath(fs.paths.files, "d"), DEFAULT_MEDIA_LIMITS),
    ).rejects.toBeInstanceOf(MediaError);
  });
});
