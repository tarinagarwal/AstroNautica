/**
 * Self-update (spec §8.2): the owner-signed `releases` list names each Android build's version, SHA-256, size,
 * download URLs and signing certificate. The newest build is downloaded through the app's network layer (Tor/DoH),
 * and installation is offered only when the file's SHA-256 and size match the list, the APK is this app at that
 * version, and its signing certificate is the one the list names and the one this app is signed with.
 */
import type { AndroidRelease, ReleaseEntry } from "@azaadawaaz/core";
import { joinPath, type FileSystem, type Http } from "../platform/types";

export interface InstalledApp {
  packageName: string;
  versionName: string;
  versionCode: number;
}

export interface ApkInfo {
  packageName: string;
  versionName: string;
  versionCode: number;
  certSha256: string[];
}

export interface ApkInspector {
  apkInfo(path: string): Promise<ApkInfo>;
  ownCertSha256(): Promise<string[]>;
}

/** The newest Android release with a higher versionCode than the installed one. */
export function newestRelease(releases: ReleaseEntry[], installed: InstalledApp): AndroidRelease | undefined {
  return releases
    .filter((r): r is AndroidRelease => r.platform === "android" && r.versionCode > installed.versionCode)
    .sort((a, b) => b.versionCode - a.versionCode)[0];
}

export class UpdateError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

/** Check a downloaded APK against the signed release entry and the installed app. Throws UpdateError. */
export function checkApk(info: ApkInfo, release: AndroidRelease, installed: InstalledApp, ownCerts: string[]): void {
  if (info.packageName !== installed.packageName)
    throw new UpdateError("update.error.package", `the file is a different app (${info.packageName})`);
  if (info.versionCode !== release.versionCode)
    throw new UpdateError(
      "update.error.version",
      `the file is version ${info.versionCode}, the list says ${release.versionCode}`,
    );
  if (info.versionCode <= installed.versionCode)
    throw new UpdateError("update.error.version", "the file is not newer than the installed app");
  const certs = info.certSha256.map((c) => c.toLowerCase());
  if (!certs.includes(release.signingCertSha256.toLowerCase()))
    throw new UpdateError(
      "update.error.cert",
      "the file's signing certificate is not the one on the signed release list",
    );
  if (!certs.some((c) => ownCerts.map((o) => o.toLowerCase()).includes(c)))
    throw new UpdateError("update.error.cert", "the file is not signed with this app's certificate");
}

export async function downloadRelease(args: {
  release: AndroidRelease;
  installed: InstalledApp;
  http: Http;
  fs: FileSystem;
  inspector: ApkInspector;
  onProgress?: (bytes: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { release, fs } = args;
  const dir = joinPath(fs.paths.cache, "updates");
  await fs.mkdirs(dir);
  const dest = joinPath(dir, `azaadawaaz-${release.versionCode}.apk`);
  const existing = await fs.stat(dest);
  if (!(existing.exists && existing.size === release.size && (await fs.sha256(dest)) === release.sha256)) {
    let ok = false;
    let last: unknown;
    for (const url of release.urls) {
      try {
        const r = await args.http.download({
          url,
          dest,
          sha256: release.sha256,
          maxBytes: release.size,
          onProgress: args.onProgress,
          signal: args.signal,
          timeoutMs: 120_000,
        });
        if (r.size !== release.size)
          throw new UpdateError("update.error.size", "downloaded size differs from the list");
        ok = true;
        break;
      } catch (e) {
        last = e;
        if (args.signal?.aborted) throw e;
      }
    }
    if (!ok)
      throw last instanceof UpdateError
        ? last
        : new UpdateError("update.error.download", String((last as Error)?.message ?? last));
  }
  const [info, own] = await Promise.all([args.inspector.apkInfo(dest), args.inspector.ownCertSha256()]);
  try {
    checkApk(info, release, args.installed, own);
  } catch (e) {
    await fs.remove(dest).catch(() => undefined);
    throw e;
  }
  return dest;
}
