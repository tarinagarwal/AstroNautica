import NativeAzaadFiles from "../native/specs/NativeAzaadFiles";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import type { FilePatch, FileStat, FileSystem, ZipEntry } from "./types";

const paths = JSON.parse(NativeAzaadFiles.paths()) as { files: string; cache: string };

/** App-private file storage through the native module (bytes cross the bridge as base64). */
export const nativeFiles: FileSystem = {
  paths,
  writeBytes: (path, data, append = false) => NativeAzaadFiles.writeBase64(path, bytesToBase64(data), append),
  readBytes: async (path, offset = 0, length = -1) => base64ToBytes(await NativeAzaadFiles.readBase64(path, offset, length)),
  writeText: (path, text) => NativeAzaadFiles.writeText(path, text),
  readText: (path) => NativeAzaadFiles.readText(path),
  stat: async (path) => JSON.parse(await NativeAzaadFiles.stat(path)) as FileStat,
  remove: (path) => NativeAzaadFiles.remove(path),
  mkdirs: (path) => NativeAzaadFiles.mkdirs(path),
  list: async (path) => JSON.parse(await NativeAzaadFiles.list(path)) as string[],
  move: (from, to) => NativeAzaadFiles.move(from, to),
  copy: (from, to) => NativeAzaadFiles.copy(from, to),
  sha256: (path) => NativeAzaadFiles.sha256File(path),
  patch: (src: string, dest: string, patches: FilePatch[], truncate?: number) =>
    NativeAzaadFiles.patchFile(
      JSON.stringify({
        src,
        dest,
        patches: patches.map((p) =>
          p.zero ? { offset: p.offset, zero: p.zero } : { offset: p.offset, dataB64: bytesToBase64(p.data) },
        ),
        truncate,
      }),
    ),
  zipDir: (dir, out) => NativeAzaadFiles.zipDir(dir, out),
  unzip: async (zip, destDir, limits) =>
    (JSON.parse(await NativeAzaadFiles.unzip(zip, destDir, limits.maxBytes, limits.maxEntries)) as { entries: ZipEntry[] })
      .entries,
};

export interface PickedDocument {
  uri: string;
  name: string;
  size: number;
  mime: string;
}

export const nativeDocuments = {
  pick: async (mimeTypes: string[], multiple = false): Promise<PickedDocument[]> =>
    JSON.parse(await NativeAzaadFiles.pickDocuments(JSON.stringify(mimeTypes), multiple)) as PickedDocument[],
  importUri: async (uri: string, destPath: string, maxBytes: number) =>
    JSON.parse(await NativeAzaadFiles.importUri(uri, destPath, maxBytes)) as { size: number; name: string; mime: string },
  share: (path: string, mime: string, title: string) => NativeAzaadFiles.shareFile(path, mime, title),
  saveAs: (path: string, name: string, mime: string) => NativeAzaadFiles.saveAs(path, name, mime),
  imageToJpeg: async (src: string, dest: string, quality = 92) =>
    JSON.parse(await NativeAzaadFiles.imageToJpeg(src, dest, quality)) as { width: number; height: number },
  takePendingIntent: async () => {
    const s = await NativeAzaadFiles.takePendingIntent();
    return s ? (JSON.parse(s) as { action: string; uri: string; mime?: string }) : null;
  },
  setSecureScreen: (on: boolean) => NativeAzaadFiles.setSecureScreen(on),
};
