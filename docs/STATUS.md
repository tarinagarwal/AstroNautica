# Build status

Updated after every phase. Newest first within each section.

## Phases

| # | Phase | State |
|---|---|---|
| 1 | `packages/schema`, `packages/core` | **Done**: 22 + 37 unit tests and 1 real-relay integration test pass; lint, typecheck clean |
| – | `packages/contracts` (from phase 3, done early) | **Done**: 49 Foundry tests (unit, fuzz, invariant); deployed and exercised on anvil |
| 2 | `services/api` | **Done**: 78 integration tests on real Postgres; every transition, auth, invites, uploads, first-approval-wins |
| 3 | `services/media`, `packages/media-strip`, `services/publisher`, E2E | **Done**: media-strip 55 tests, media 23 tests (real ffmpeg/exiftool media); publisher units; **`scripts/e2e.mjs` 62/62 checks** on the dev network (story published 4 s after approval; Arweave + receipts on both chains verified by a clean client; tamper → red; comments/PoW/hide; changes/reject; unlist + override; one relay/IPFS node/chain down → still readable; rebuild into an empty IPFS node; no IPs in logs) |
| 4 | `apps/web` | In progress (agent) |
| 5 | `apps/android` | In progress (agent); Android SDK via Docker image `reactnativecommunity/react-native-android` (dl.google.com is blocked here) |
| 6 | `infra`, runbooks, rebuild script, threat model | Dev stack done and verified (9 services); prod + mirror compose written; relay PoW/rate-limit policy with tests; threat model, 5 runbooks, owner/ops scripts, rebuild-archive, mirror-sync done. Left: reconcile prod env names with services, CI workflow |

## Decisions taken without the owner (sensible defaults; see docs/decisions.md)
- D7: receipts on Base **and** BSC (owner asked about BSC).
- D8/D9: tooling and crypto libraries.
- Contract: storyId must be non-zero; evm_version paris; optimizer 10k runs.

## Dev network quick start
```sh
dockerd &   # if Docker isn't running
cd infra/dev && docker compose up -d --wait && cd ../..
node scripts/dev-setup.mjs          # sample keys, registry on 2 chains, signed lists → .dev/
```

## Next steps
1. Integrate the web app (agent) and the Android app (agent); web E2E against the real API and publisher.
2. Reconcile `infra/prod` env names with the services (api: PUBLIC_URL/OWNER_PUBKEY/RELAYS; publisher names in its README).
3. Security review, fixes, handover.

## Owner decisions pending (only the owner can make these)
See the final handover; collected here as they come up:
- Real domains and registrar accounts (azaadawaaz.org/.news/.net), hosting providers in ≥ 2 countries.
- Pinning service account (Filebase / Pinata / 4EVERLAND) and Arweave/Turbo funding.
- Chain funding for the publisher EVM key on Base and BSC.
- Owner key ceremony (generate offline, paper backup).
- Telegram channel name, branding.
