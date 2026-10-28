import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/** App-private storage, hashing, zip bundles, document pickers, sharing and image conversion. */
export interface Spec extends TurboModule {
  /** {"files","cache"} absolute paths of the app's private directories. */
  paths(): string;
  writeBase64(path: string, dataB64: string, append: boolean): Promise<void>;
  /** length < 0 reads to the end. */
  readBase64(path: string, offset: number, length: number): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  readText(path: string): Promise<string>;
  /** {"exists","size","isDir","mtime"} */
  stat(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  mkdirs(path: string): Promise<void>;
  /** JSON array of entry names. */
  list(path: string): Promise<string>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  sha256File(path: string): Promise<string>;
  /** Writes `count` zero bytes or copies byte ranges: {"src","dest","patches":[{"offset","dataB64"}],"truncate"?} */
  patchFile(requestJson: string): Promise<void>;
  zipDir(dir: string, out: string): Promise<void>;
  /** {"entries":[{"name","size"}]}; rejects on path traversal or when limits are exceeded. */
  unzip(zipPath: string, destDir: string, maxBytes: number, maxEntries: number): Promise<string>;
  /** Copies a content:// or file:// URI into an app file: {"size","name","mime"} */
  importUri(uri: string, destPath: string, maxBytes: number): Promise<string>;
  /** Document picker. JSON array of {"uri","name","size","mime"} ([] when cancelled). */
  pickDocuments(mimeTypesJson: string, multiple: boolean): Promise<string>;
  shareFile(path: string, mime: string, title: string): Promise<void>;
  /** Lets the user save a copy (ACTION_CREATE_DOCUMENT). Resolves false when cancelled. */
  saveAs(path: string, suggestedName: string, mime: string): Promise<boolean>;
  /** Decode any supported image (HEIC included), apply its orientation and write a metadata-free JPEG: {"width","height"} */
  imageToJpeg(src: string, dest: string, quality: number): Promise<string>;
  /** The file or link the app was opened with, if any: {"action","uri","mime"} or null. */
  takePendingIntent(): Promise<string | null>;
  /** Block screenshots and the recent-apps preview (moderator previews, key backup). */
  setSecureScreen(on: boolean): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>("AzaadFiles");
