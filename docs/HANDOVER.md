# Handover

Everything in `docs/SPEC.md` is built on branch `ccr-2fc6e99f-vk51vj`, tested phase by phase, security-reviewed, and the
review's findings are fixed. It runs locally on the dev network (no production deployment, as asked).

## What's built

| Part | State | Tests |
|---|---|---|
| `packages/schema` | Manifest types, RFC 8785 JCS, approval body, strict validation | 23 |
| `packages/core` | Keys, two-tier signed lists (+ vouched), verified fetching, stories, comments/PoW, staging crypto, NIP-98, invites, i18n, hostile-relay-safe relay pool | 41 + relay integration |
| `packages/media-strip` | Lossless on-device stripping, JPEG/PNG/WebP/MP4/MOV, checked with exiftool/ffprobe on real files | 55 |
| `packages/contracts` | `AzaadAwaazRegistry`, receipts per writer, Base + BSC config | 56 (unit, fuzz, invariant) |
| `services/api` | Invites, auth, encrypted staging, moderation state machine, audit, quotas, DB roles | 92 (real Postgres) |
| `services/media` | Sandboxed processing as an isolated worker (no secrets, no internet) | 27 |
| `services/publisher` | Full pipeline: IPFS ×2, pinning API, torrents, manifest, Nostr, 2 chains, Arweave, storage receipts | units + E2E |
| `services/mirror-sync` | Mirror kit sync: verified archive + signed web releases | run against the dev network |
| `apps/web` | Reader, Verify, comments, contributor, moderator and owner areas, en/hi | 53 unit, 8 browser (mocked), 1 real-stack browser journey |
| `apps/android` | React Native: reader, Tor + Snowflake/obfs4, DoH, offline bundles, contributor/moderator, self-update | 98 Jest, 42 Kotlin |
| `infra` | Dev network, prod and mirror compose, relay allowlist policy, nginx, Tor | relay policy 44 |
| `scripts` | Dev setup, E2E, owner key/list tools, archive rebuild, web releases | E2E **62/62** |

The end-to-end test (`node scripts/e2e.mjs`) covers, on real services: invite → contributor with GPS-tagged photo and
video (stripped on the device) → moderator review → published 3 s after approval → a clean client verifies everything
(IPFS, Arweave, receipts on both chains) → tamper detection → comments with PoW, hiding → change requests and rejection
→ unlisting and owner override → one relay / IPFS node / chain stopped and still readable → full archive rebuilt into
an empty IPFS node with no database → no IP addresses in any log.

## Links

- Branch: https://github.com/tarinagarwal/AstroNautica/tree/ccr-2fc6e99f-vk51vj
- Start here: `README.md`, then `docs/STATUS.md`, `docs/decisions.md` (D1–D22), `docs/threat-model.md`, `docs/runbooks/`.
- Everything runs on `localhost` inside the build machine, so nothing is reachable from outside. To see it yourself,
  follow "Run it locally" in `README.md` on your computer (about 10 minutes the first time).

## Security review

An independent review found 14 issues (3 high). All are fixed with tests: decisions D17–D22 and the "security review
fixes" section at the end of `docs/architecture.md`.

## Not done here, and why

1. **No Android APK.** The Android build needs Google's Maven repository (`dl.google.com`), which this environment's
   network policy blocks. The code, Jest and Kotlin tests, Metro + Hermes bundle all pass; the APK build itself is
   `apps/android/scripts/build-release.sh` on any machine with normal internet, or here after allowing
   `dl.google.com` (and `repo.reactnative.dev`) in the environment's network settings
   (https://code.claude.com/docs/en/cloud-environments#network-access).
2. **Not exercised on a phone:** Tor bootstrap, Wi-Fi Direct sharing, Keystore/biometrics, installer, video playback.
   Bluetooth (RFCOMM) sharing was not built; Wi-Fi Direct and the share sheet are.
3. **Tor network unreachable here:** onion service configs are generated and validated offline, not reached over Tor.
4. **No mainnet or real third-party services:** the pinning client is tested against the standard API, Arweave against
   ArLocal, chains against local anvil nodes.
5. **WebTorrent in the browser skipped** (needs peers outside the strict CSP); the web falls back from HLS to the
   hash-verified MP4. Torrents with web seeds are created and seeded by the server.

## Decisions only you can make

**Accounts and money**
1. Domains (azaadawaaz.org/.news/.net) and registrar (Njalla, Porkbun or Namecheap); never `.in`.
2. Hosting: two providers in two countries outside India.
3. Pinning service (Filebase, Pinata or 4EVERLAND) and its API token.
4. Arweave wallet funding and the video budget (`ARWEAVE_MAX_VIDEO_BYTES`; 0 = videos only on IPFS + torrents).
5. Chains: Base and BNB Smart Chain both by default (you asked about BSC). Confirm, then fund the publisher's EVM
   key on each and deploy the registry with the owner's EVM key (hardware wallet).

**People and identity**
6. The owner key ceremony on an offline machine (`docs/runbooks/owner-key-ceremony.md`).
7. The first moderators (each makes a Nostr key and an X25519 key) and the first contributors to invite.
8. Telegram channel name, logo, colours, and the tagline in English and Hindi.
9. Who holds the Android release signing key, and where it's backed up.

**Defaults I picked; change any of them**
10. The owner can approve stories like a moderator; nobody can review their own submission.
11. Unlisting limits: 5 per hour per moderator in the API, and in clients 20 per day and 100 in total per moderator
    before the owner has to confirm.
12. Unpublished drafts expire after 30 days; staging quotas are 4 GB per submission and 8 GB per contributor.
13. Photos are re-encoded on the device (JPEG quality 92) so the camera model can't be identified from the file.
    This costs a little quality; PNG stays lossless.
14. Mirrors keep unlisted stories (they only stop being shown in official clients).

**Operational security** (`docs/threat-model.md` §1): how domains, hosting and services are paid for, and who the
operators are, matters more than any code.

## Next steps once you've decided
1. Build the APK (see above) and sign it with the release key; add its entry with `scripts/owner-sign-list.mjs releases`.
2. Owner ceremony, then sign the first lists offline and publish them (`scripts/publish-events.mjs`).
3. Fill `infra/prod/.env` and `infra/prod/secrets/` on each host; `docker compose up -d`.
4. Deploy the registry on Base and BSC (`packages/contracts/README.md`); put the addresses in `CHAINS_JSON`.
5. Put the web build on IPFS (`scripts/publish-web-release.mjs`) and sign the release entry.
