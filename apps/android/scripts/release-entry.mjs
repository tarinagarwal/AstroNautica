#!/usr/bin/env node
// Prints the `releases` list entry for a built APK, ready for `node scripts/owner-sign-list.mjs releases --add <file>`:
// version, versionCode, sha256, size, signingCertSha256 and the download URLs.
//
//   node scripts/release-entry.mjs [apk] [--url https://…]… [--out release.json] [--notes-en "…"] [--notes-hi "…"]
//
// The certificate hash comes from `apksigner verify --print-certs` when an Android SDK is available
// (ANDROID_HOME or APKSIGNER), otherwise from `keytool -printcert -jarfile` (the APK is also v1-signed).
// The version comes from `aapt2 dump badging` when available, otherwise from android/gradle.properties (or the
// AZAAD_VERSION_NAME / AZAAD_VERSION_CODE overrides used by the build).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const urls = [];
let out;
const notes = {};
let apk = resolve(here, "../android/app/build/outputs/apk/release/app-release.apk");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") urls.push(args[++i]);
  else if (args[i] === "--out") out = args[++i];
  else if (args[i] === "--notes-en") notes.en = args[++i];
  else if (args[i] === "--notes-hi") notes.hi = args[++i];
  else apk = resolve(args[i]);
}
if (!existsSync(apk)) {
  console.error(`release-entry: ${apk} not found`);
  process.exit(1);
}

const bytes = readFileSync(apk);
const sha256 = createHash("sha256").update(bytes).digest("hex");

function buildTool(name) {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()];
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk || !existsSync(join(sdk, "build-tools"))) return undefined;
  const versions = readdirSync(join(sdk, "build-tools")).sort().reverse();
  for (const v of versions) if (existsSync(join(sdk, "build-tools", v, name))) return join(sdk, "build-tools", v, name);
  return undefined;
}

function certSha256() {
  const apksigner = buildTool("apksigner");
  if (apksigner) {
    const text = execFileSync(apksigner, ["verify", "--print-certs", apk], { encoding: "utf8" });
    const m = text.match(/certificate SHA-256 digest: ([0-9a-f]{64})/i);
    if (m) return m[1].toLowerCase();
  }
  const text = execFileSync("keytool", ["-printcert", "-jarfile", apk], { encoding: "utf8" });
  const m = text.match(/SHA256:\s*([0-9A-F:]{95})/i);
  if (!m) throw new Error("could not read the signing certificate (is the APK signed?)");
  return m[1].replace(/:/g, "").toLowerCase();
}

function version() {
  const aapt2 = buildTool("aapt2");
  if (aapt2) {
    const text = execFileSync(aapt2, ["dump", "badging", apk], { encoding: "utf8" });
    const code = text.match(/versionCode='(\d+)'/);
    const name = text.match(/versionName='([^']*)'/);
    if (code && name) return { version: name[1], versionCode: Number(code[1]) };
  }
  const props = Object.fromEntries(
    readFileSync(resolve(here, "../android/gradle.properties"), "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  return {
    version: process.env.AZAAD_VERSION_NAME ?? props.azaadVersionName,
    versionCode: Number(process.env.AZAAD_VERSION_CODE ?? props.azaadVersionCode),
  };
}

const entry = {
  platform: "android",
  ...version(),
  sha256,
  size: statSync(apk).size,
  urls,
  signingCertSha256: certSha256(),
  ...(notes.en || notes.hi ? { notes } : {}),
};
if (!urls.length) console.error("release-entry: no --url given; add the download URLs before signing the list");
const json = JSON.stringify(entry, null, 2);
if (out) writeFileSync(out, json + "\n");
console.log(json);
