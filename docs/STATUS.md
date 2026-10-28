# Build status

Updated after every phase. Newest first within each section.

## Phases

| # | Phase | State |
|---|---|---|
| 1 | `packages/schema`, `packages/core` | **Done**: 22 + 37 unit tests and 1 real-relay integration test pass; lint, typecheck clean |
| – | `packages/contracts` (from phase 3, done early) | **Done**: 49 Foundry tests (unit, fuzz, invariant); deployed and exercised on anvil |
| 2 | `services/api` | **Done**: 78 integration tests on real Postgres; every transition, auth, invites, uploads, first-approval-wins |
| 3 | `services/media`, `packages/media-strip`, `services/publisher`, E2E | **Done**: media-strip 55 tests, media 23 tests (real ffmpeg/exiftool media); publisher units; **`scripts/e2e.mjs` 62/62 checks** on the dev network (story published 4 s after approval; Arweave + receipts on both chains verified by a clean client; tamper → red; comments/PoW/hide; changes/reject; unlist + override; one relay/IPFS node/chain down → still readable; rebuild into an empty IPFS node; no IPs in logs) |
| 4 | `apps/web` | **Done**: 53 unit + 8 mocked e2e + 1 real-stack browser journey (owner invite → contributor → moderator → published → reader verifies, comments, hide) |
| 5 | `apps/android` | **Done in code**: 98 Jest + 42 Kotlin tests, Metro + Hermes bundle; APK not built here (dl.google.com blocked by the environment's network policy) |
| 6 | `infra`, runbooks, rebuild script, threat model | **Done** |

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

## Security review (done) and fixes
An independent review found 14 issues (3 high). All fixed, with tests — see decisions D17–D22 and
`docs/architecture.md` "Deviations → security review fixes": verify-before-dedupe relay pool; retired keys only for
vouched manifests; per-writer chain receipts; relay allowlist (no deletions); moderator cap hardening; strict schema
keys + field-by-field manifest; publisher re-proves manifests before signing; isolated media container; verified,
capped archive/mirror downloads; API quotas, DB replay store, no self-review, DB roles; Kubo RPC isolation; sandboxed
gateway CSP; owner tooling shows diffs.

## Next steps
All phases done; see `docs/HANDOVER.md` for what's left for the owner (accounts, keys, APK build, production).

## Owner decisions pending (only the owner can make these)
See the final handover; collected here as they come up:
- Real domains and registrar accounts (azaadawaaz.org/.news/.net), hosting providers in ≥ 2 countries.
- Pinning service account (Filebase / Pinata / 4EVERLAND) and Arweave/Turbo funding.
- Chain funding for the publisher EVM key on Base and BSC.
- Owner key ceremony (generate offline, paper backup).
- Telegram channel name, branding.
