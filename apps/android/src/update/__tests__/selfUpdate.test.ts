import { createHash } from "node:crypto";
import type { AndroidRelease, ReleaseEntry } from "@azaadawaaz/core";
import { fakeHttp, nodeFs } from "../../test/nodePlatform";
import { UpdateError, checkApk, downloadRelease, newestRelease, type ApkInfo } from "../selfUpdate";

const apk = Uint8Array.from({ length: 4096 }, (_, i) => (i * 3) & 255);
const sha = createHash("sha256").update(apk).digest("hex");
const CERT = "c".repeat(64);
const installed = { packageName: "org.azaadawaaz.app", versionName: "0.1.0", versionCode: 1 };
const release: AndroidRelease = {
  platform: "android",
  version: "0.2.0",
  versionCode: 2,
  sha256: sha,
  size: apk.length,
  urls: ["https://a.example/app.apk", "https://b.example/app.apk"],
  signingCertSha256: CERT,
};
const info: ApkInfo = { packageName: installed.packageName, versionName: "0.2.0", versionCode: 2, certSha256: [CERT] };

describe("self-update", () => {
  it("picks the newest Android release above the installed version", () => {
    const list: ReleaseEntry[] = [
      { ...release, versionCode: 2 },
      { ...release, versionCode: 5, version: "0.5.0" },
      { platform: "web", version: "9", versionCode: 99, cid: "bafy" + "a".repeat(55) },
      { ...release, versionCode: 1 },
    ];
    expect(newestRelease(list, installed)?.versionCode).toBe(5);
    expect(newestRelease(list, { ...installed, versionCode: 5 })).toBeUndefined();
  });

  it("checks package, version and signing certificate", () => {
    expect(() => checkApk(info, release, installed, [CERT])).not.toThrow();
    expect(() => checkApk({ ...info, packageName: "evil" }, release, installed, [CERT])).toThrow(/different app/);
    expect(() => checkApk({ ...info, versionCode: 3 }, release, installed, [CERT])).toThrow(UpdateError);
    expect(() => checkApk({ ...info, certSha256: ["d".repeat(64)] }, release, installed, [CERT])).toThrow(
      /signed release list/,
    );
    expect(() => checkApk(info, { ...release, signingCertSha256: CERT }, installed, ["e".repeat(64)])).toThrow(
      /this app's certificate/,
    );
    expect(() => checkApk({ ...info, versionCode: 1 }, { ...release, versionCode: 1 }, installed, [CERT])).toThrow(
      /not newer/,
    );
  });

  it("downloads through the network layer, verifies the hash, and tries the next URL on a bad copy", async () => {
    const fs = nodeFs();
    const http = fakeHttp(
      (req) =>
        req.url.startsWith("https://a.") ? { body: Uint8Array.from(apk, (x, i) => (i ? x : x ^ 1)) } : { body: apk },
      fs,
    );
    const path = await downloadRelease({
      release,
      installed,
      http,
      fs,
      inspector: { apkInfo: async () => info, ownCertSha256: async () => [CERT] },
    });
    expect(await fs.sha256(path)).toBe(sha);
    expect(http.requests.map((r) => r.url)).toEqual(release.urls);
  });

  it("deletes a download whose certificate doesn't match", async () => {
    const fs = nodeFs();
    const http = fakeHttp(() => ({ body: apk }), fs);
    const err = await downloadRelease({
      release,
      installed,
      http,
      fs,
      inspector: {
        apkInfo: async () => ({ ...info, certSha256: ["f".repeat(64)] }),
        ownCertSha256: async () => [CERT],
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect((await fs.list(fs.paths.cache + "/updates")).length).toBe(0);
    const none = fakeHttp(() => ({ status: 404 }), fs);
    await expect(
      downloadRelease({
        release,
        installed,
        http: none,
        fs,
        inspector: { apkInfo: async () => info, ownCertSha256: async () => [CERT] },
      }),
    ).rejects.toMatchObject({ key: "update.error.download" });
  });
});
