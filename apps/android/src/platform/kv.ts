import { sha256Hex } from "@azaadawaaz/schema";
import { joinPath, type FileSystem } from "./types";

/**
 * A small JSON key-value store on app-private files (lists, story events, settings, drafts, upload state). Keys are
 * hashed into file names; writes go to a temporary file first and are then moved into place.
 */
export class JsonStore {
  private readonly dir: string;
  private ready?: Promise<void>;

  constructor(
    private readonly fs: FileSystem,
    name: string,
  ) {
    this.dir = joinPath(fs.paths.files, "store", name);
  }

  private init(): Promise<void> {
    return (this.ready ??= this.fs.mkdirs(this.dir));
  }

  private file(key: string): string {
    return joinPath(this.dir, sha256Hex(key).slice(0, 40) + ".json");
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.init();
    try {
      return JSON.parse(await this.fs.readText(this.file(key))) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.init();
    const f = this.file(key);
    const tmp = f + ".tmp";
    await this.fs.writeText(tmp, JSON.stringify(value));
    await this.fs.move(tmp, f);
  }

  async delete(key: string): Promise<void> {
    await this.init();
    await this.fs.remove(this.file(key)).catch(() => undefined);
  }
}
