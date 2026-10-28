# AzaadAwaaz for Android (`apps/android`)

Bare React Native 0.88 app (TypeScript, Hermes, New Architecture/TurboModules) that reuses `packages/core`,
`packages/schema` and `packages/media-strip` from the workspace. Spec §8.2. Not on any app store: signed APK,
self-updating from the owner-signed `releases` list.

## Layout

| Path | What |
|---|---|
| `src/data` | Reader data layer: lists, stories, manifests (`appData.ts`), gateway racing and trustless IPFS (`gateways.ts`, `ipfs.ts`), Verify (`verify.ts`, `eth.ts`), comments/reactions with PoW (`social.ts`, `pow.ts`), verified media cache (`media.ts`) |
| `src/offline` | Offline bundles (`bundle.ts`) and saved stories (`store.ts`) |
| `src/contributor` | Editor model (`draft.ts`), on-device metadata stripping (`media.ts`, `bmffSkeleton.ts`), encryption + resumable upload (`upload.ts`), invites, feedback |
| `src/moderator` | Queue/review/approve/reject/changes/re-wrap (`review.ts`), media preview (`preview.ts`), signed list actions (`actions.ts`) |
| `src/update` | Self-update verification (`selfUpdate.ts`) |
| `src/net`, `src/security` | Tor/DoH transport choice and auto-Tor; key ring and app-lock policy |
| `src/platform` | Interfaces and the native implementations (HTTP, files, WebSocket, events) |
| `src/crypto` | libsodium-wrappers adapter backed by native libsodium (see below) |
| `src/native/specs` | TurboModule specs (codegen) |
| `src/ui` | Screens and components (custom stack navigator, safe Markdown renderer, blurhash, video) |
| `android/app/src/main/java/org/azaadawaaz/app/core` | Platform-independent Kotlin: OkHttp + DoH (`NetCore`), HTTP/WebSocket bridges, trustless IPFS streaming, libsodium ops, PoW miner, zip bundles, Wi-Fi Direct protocol, PIN vault, torrc |
| `android/app/src/main/java/org/azaadawaaz/app/modules` | TurboModules: Net, Sodium, Files, Tor, Vault, Pow, Update, P2P |
| `android/jvm-tests` | JUnit tests of the Kotlin core on a plain JVM (no Android SDK needed) |
| `android/compile-check` | Compiles the Android-specific Kotlin against `android.jar` without AGP (`-Preact=true` adds the TurboModules, which need react-android from repo.reactnative.dev) |

## Commands

```sh
pnpm -r --filter "./packages/*" build          # libraries first (Metro and Jest use their dist/)
pnpm --filter @azaadawaaz/android typecheck
pnpm --filter @azaadawaaz/android test           # Jest: logic (Node) + UI (RN preset)
TEST_DEVNET=1 pnpm --filter @azaadawaaz/android test -- devnet   # read-only against infra/dev
pnpm --filter @azaadawaaz/android bundle         # Metro bundle (checks the whole JS graph resolves)
node scripts/run-codegen.mjs                     # TurboModule codegen → build/codegen
node scripts/gen-sodium-vectors.mjs              # vectors from core for the Kotlin byte-compat tests
(cd android/jvm-tests && gradle test)            # Kotlin core tests (then rerun Jest: it checks Kotlin's output too)
(cd android/compile-check && gradle compileKotlin -PandroidJar=<sdk>/platforms/android-37/android.jar [-Preact=true])
sh scripts/create-release-keystore.sh            # release keystore outside git
sh scripts/build-release.sh                      # signed APK in reactnativecommunity/react-native-android
node scripts/release-entry.mjs <apk> --url …     # JSON for scripts/owner-sign-list.mjs releases --add
```

Dev network on a phone: `adb reverse tcp:7777 tcp:7777` (and 7778, 8080, 8081, 8545, 8546, 8787), because the signed
lists name `127.0.0.1`. Debug builds allow cleartext only to 127.0.0.1, 10.0.2.2 and localhost; release builds allow
no cleartext at all.

## Decisions made here

- **libsodium on Hermes.** `libsodium-wrappers` 0.7.15 is WebAssembly-only and Hermes has no WebAssembly (verified:
  it aborts). `react-native-libsodium` (JSI) lacks `crypto_secretstream_*`, which staging needs. So Metro maps
  `libsodium-wrappers` to `src/crypto/sodiumAdapter.ts`, a libsodium-wrappers-compatible object over a synchronous
  TurboModule backed by real libsodium (lazysodium-android). `packages/core/staging.ts` runs unchanged. Proven
  byte-compatible both ways: Kotlin `SodiumOps` opens vectors made by core (JUnit), and core opens what Kotlin made
  (`kotlinVectors.test.ts`); the adapter's marshalling is tested under core's own staging code. Large media is
  encrypted/decrypted natively file-to-chunk-files without crossing the bridge.
- **Networking.** One OkHttp client (4.12, React Native's major version, with `okhttp-dnsoverhttps`) for requests,
  downloads, uploads and relay WebSockets (a WebSocket class passed to nostr-tools). Direct mode: DoH via Quad9,
  Cloudflare and Mullvad by IP address, system DNS as last resort, `.onion` never resolved. Tor mode: SOCKS to tor
  with names resolved by Tor; local DNS is refused. While Tor is wanted but not connected, requests fail ("blocked")
  instead of going out directly. Auto-Tor turns on when every relay and every gateway fails a direct probe.
- **Tor.** `info.guardianproject:tor-android:0.4.9.14` (bound `TorService`, torrc written first: `SOCKSPort auto`,
  no HTTP tunnel/DNS/Trans ports) plus `com.netzarchitekten:IPtProxy:5.7.0` for Snowflake and obfs4; bridge lines are
  Tor Browser's public defaults (`assets/builtin-bridges.json`, from Orbot). Status is polled from tor's control
  connection (bootstrap %, circuit, SOCKS port).
- **Video.** HLS through a non-exported `ContentProvider` (`content://org.azaadawaaz.app.media/ipfs/<cid>/…`) that
  streams every IPFS block verified against its CID, with gateway failover, over the same network stack. A provider
  instead of a loopback HTTP server keeps release builds free of cleartext. If HLS fails, the MP4 fallback is
  downloaded and played only if its SHA-256 matches the manifest.
- **Metadata.** JPEGs are always re-encoded through `Bitmap.compress` (quality 92, longest edge ≤ 4096 px) so camera
  quantisation tables can't identify the device; HEIC/AVIF/GIF and rotated photos are converted the same way.
  Everything is then stripped by media-strip with `keepIcc: false`, so the "metadata removed ✓" badge appears only
  when `findMetadata` on the stored file returns an empty list. Videos are stripped without re-encoding: a
  "skeleton" (all boxes except mdat payloads) goes through media-strip unchanged, the changed bytes are patched into
  the file, and samples of dropped data tracks (GPS telemetry, subtitles) are zeroed; tests check the result equals
  media-strip on the whole file byte for byte for every fixture. The story id (UUIDv7) is generated at submission.
- **Keys.** Secrets are encrypted with a non-exportable Android Keystore AES-GCM key (StrongBox when present). With
  an app lock they are additionally encrypted under a PBKDF2 (210k) PIN key; biometric unlock releases the PIN key
  through a second, biometric-bound Keystore key (`androidx.biometric` CryptoObject). Wrong PINs back off from the
  5th attempt (30 s doubling to 1 h). The lock is required before contributor or moderator keys can be stored.
- **Offline sharing.** Bundles are zips: `azaad-bundle.json` (index), `events.json` (publisher-signed story event,
  signed list events, storage receipts), `manifest.json` (exact bytes), `media/<sha256>`. On import nothing is shown
  until the story event chains to a publisher key on owner-signed lists (pinned owner key), the manifest passes core
  `verifyManifest`, and every file is referenced by the manifest and hashes to its name; unknown or traversal
  entries reject the bundle. Transports: Android share sheet / "save file" / opening a file, and **Wi-Fi Direct**
  (`android.net.wifi.p2p` + a TCP socket with a role handshake, size and SHA-256 check). Google Nearby is not used
  (Play Services). Bluetooth RFCOMM was not implemented (Wi-Fi Direct is far faster for videos).
- **Self-update.** Newest Android entry above the installed versionCode; downloaded through Tor/DoH, SHA-256 and size
  checked, then `PackageManager.getPackageArchiveInfo(GET_SIGNING_CERTIFICATES)` must show this app's package, the
  listed versionCode and a certificate equal to both `signingCertSha256` and the installed app's; install via
  FileProvider + `ACTION_VIEW` (`REQUEST_INSTALL_PACKAGES`).
- **Lists.** First-seen times of moderator-list entries are persisted (`lists:firstSeen`) and passed to
  `buildEffectiveLists`. Chain receipts use `receipt(bytes16,uint32,address)` for each publisher EVM address and count
  only if `wasPublisherEvmAt` holds at the block time.
- **No third parties.** No analytics, crash reporting or Play Services; links in stories open only after a
  confirmation that says they leave the app's Tor/DoH protection.
- **App Links.** `https://azaadawaaz.{org,news,net}` links are declared with `autoVerify`; verification needs
  `/.well-known/assetlinks.json` with the release certificate on each domain (owner task). `azaadawaaz://invite/…`
  and pasted links always work.
