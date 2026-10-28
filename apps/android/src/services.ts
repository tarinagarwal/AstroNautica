/**
 * The app's object graph on the phone: native platform implementations wired into the framework-free modules.
 * Created once at start-up (App.tsx) and passed down through React context.
 */
import { RelayPool } from "@azaadawaaz/core";
import { Api } from "./api/client";
import { bundledConfig, type AppConfig } from "./config";
import type { UploadDeps } from "./contributor/upload";
import type { MediaTools } from "./contributor/media";
import { AppData } from "./data/appData";
import { GatewayClient } from "./data/gateways";
import { MediaStore } from "./data/media";
import type { NativeMiner } from "./data/pow";
import type { ChunkFileDecryptor } from "./moderator/preview";
import NativeAzaadPow from "./native/specs/NativeAzaadPow";
import NativeAzaadSodium from "./native/specs/NativeAzaadSodium";
import NativeAzaadUpdate from "./native/specs/NativeAzaadUpdate";
import NativeAzaadVault from "./native/specs/NativeAzaadVault";
import { NetController } from "./net/controller";
import { OfflineStore } from "./offline/store";
import { JsonStore } from "./platform/kv";
import { nativeDocuments, nativeFiles } from "./platform/nativeFiles";
import { nativeHttp } from "./platform/nativeHttp";
import { NativeWebSocket } from "./platform/nativeWebSocket";
import type { FileSystem, Http } from "./platform/types";
import { KeyRing } from "./security/keys";
import type { ApkInspector, InstalledApp } from "./update/selfUpdate";
import { base64ToBytes, bytesToBase64 } from "./util/bytes";

export interface Services {
  config: AppConfig;
  http: Http;
  fs: FileSystem;
  settings: JsonStore;
  drafts: JsonStore;
  app: AppData;
  gateways: GatewayClient;
  media: MediaStore;
  offline: OfflineStore;
  net: NetController;
  keys: KeyRing;
  miner: NativeMiner;
  mediaTools: MediaTools;
  decryptor: ChunkFileDecryptor;
  encryptFile: UploadDeps["encryptFile"];
  inspector: ApkInspector;
  installed: InstalledApp;
  api: () => Api;
  install(path: string): Promise<void>;
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
}

export function createServices(config: AppConfig = bundledConfig): Services {
  const fs = nativeFiles;
  const http = nativeHttp;
  const settings = new JsonStore(fs, "settings");
  const gateways = new GatewayClient(http);
  const pool = new RelayPool({ websocketImplementation: NativeWebSocket });
  const app = new AppData(config, pool, gateways, new JsonStore(fs, "data"), fs);
  const media = new MediaStore(fs, http, gateways);
  const offline = new OfflineStore(fs, new JsonStore(fs, "offline"));
  media.setOfflineLookup((key) => offline.lookup(key));
  return {
    config,
    http,
    fs,
    settings,
    drafts: new JsonStore(fs, "drafts"),
    app,
    gateways,
    media,
    offline,
    net: new NetController(settings, http),
    keys: new KeyRing(NativeAzaadVault),
    miner: NativeAzaadPow,
    mediaTools: { importUri: nativeDocuments.importUri, imageToJpeg: nativeDocuments.imageToJpeg },
    decryptor: {
      decryptChunks: async (header, key, chunkPaths, dest) =>
        JSON.parse(
          await NativeAzaadSodium.decryptChunks(
            JSON.stringify({ header: bytesToBase64(header), keyB64: bytesToBase64(key), chunkPaths, dest }),
          ),
        ) as { sha256: string; size: number },
    },
    encryptFile: async (src, outDir, key, chunkSize) => {
      const r = JSON.parse(
        await NativeAzaadSodium.encryptFile(JSON.stringify({ src, outDir, keyB64: bytesToBase64(key), chunkSize })),
      ) as {
        header: string;
        chunks: { n: number; size: number; sha256: string; path: string }[];
        plainSha256: string;
        plainSize: number;
      };
      return { header: base64ToBytes(r.header), chunks: r.chunks, plainSha256: r.plainSha256, plainSize: r.plainSize };
    },
    inspector: {
      apkInfo: async (path) => JSON.parse(await NativeAzaadUpdate.apkInfo(path)),
      ownCertSha256: async () => JSON.parse(await NativeAzaadUpdate.ownCertSha256()) as string[],
    },
    installed: JSON.parse(NativeAzaadUpdate.appInfo()) as InstalledApp,
    api: () => new Api(config.apiUrl, http),
    install: (path) => NativeAzaadUpdate.install(path),
    canInstall: () => NativeAzaadUpdate.canInstall(),
    openInstallSettings: () => NativeAzaadUpdate.openInstallSettings(),
  };
}
