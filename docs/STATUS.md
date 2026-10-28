# Build status

Updated after every phase. Newest first within each section.

## Phases

| # | Phase | State |
|---|---|---|
| 1 | `packages/schema`, `packages/core` | **Done**: 22 + 37 unit tests and 1 real-relay integration test pass; lint, typecheck clean |
| – | `packages/contracts` (from phase 3, done early) | **Done**: 49 Foundry tests (unit, fuzz, invariant); deployed and exercised on anvil |
| 2 | `services/api` | In progress (agent) |
| 3 | `services/media`, `packages/media-strip`, `services/publisher`, E2E | media/media-strip in progress (agent); publisher written (pipeline, IPFS, pinning API, Arweave, torrents, multi-chain receipts), waiting on media to typecheck and run E2E |
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
1. Integrate API, media, web agents' work; write `scripts/dev-setup.mjs`; build `services/publisher`.
2. End-to-end test: submit → approve → published → readable from a clean client.
3. Android app; infra prod/mirror/onion; rebuild-from-public-networks script; runbooks; threat model.
4. Security review and handover.

## Owner decisions pending (only the owner can make these)
See the final handover; collected here as they come up:
- Real domains and registrar accounts (azaadawaaz.org/.news/.net), hosting providers in ≥ 2 countries.
- Pinning service account (Filebase / Pinata / 4EVERLAND) and Arweave/Turbo funding.
- Chain funding for the publisher EVM key on Base and BSC.
- Owner key ceremony (generate offline, paper backup).
- Telegram channel name, branding.
