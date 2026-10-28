# AzaadAwaaz / आज़ादआवाज़

A bilingual (English and Hindi) news and media platform that can't be taken down or fully blocked. Invited
contributors publish stories; one moderator approval publishes them; published stories live on IPFS, Arweave,
BitTorrent and Nostr relays with tamper-proof receipts on two chains, and readers reach them through many doors (web
on several domains, an onion service, IPFS, an Android app outside the app stores, and community mirrors).

- **What and why:** [`docs/SPEC.md`](docs/SPEC.md)
- **How the pieces talk:** [`docs/architecture.md`](docs/architecture.md)
- **Decisions:** [`docs/decisions.md`](docs/decisions.md) · **Threat model:** [`docs/threat-model.md`](docs/threat-model.md)
- **Runbooks:** [`docs/runbooks/`](docs/runbooks) · **Status:** [`docs/STATUS.md`](docs/STATUS.md) · **Handover:** [`docs/HANDOVER.md`](docs/HANDOVER.md)

## Repository

| Path | What |
|---|---|
| `packages/schema` | Story manifest types, RFC 8785 canonical JSON, hashing, approval body, validation |
| `packages/core` | Shared client logic: keys, signed lists, verified fetching, stories, comments, staging crypto, auth, i18n, relays |
| `packages/media-strip` | On-device metadata stripping (JPEG, PNG, WebP, MP4/MOV) |
| `packages/contracts` | `AzaadAwaazRegistry` (Foundry) |
| `services/api` | Invites, auth, encrypted staging, moderation, audit |
| `services/media` | Sandboxed image/video processing (isolated worker) |
| `services/publisher` | The publishing pipeline |
| `services/mirror-sync` | The mirror kit's sync job |
| `apps/web` | Static web app (reader, contributor, moderator, owner) |
| `apps/android` | React Native Android app |
| `infra/` | Dev network, production and mirror compose, relay policy, nginx, Tor |
| `scripts/` | Dev setup, end-to-end test, owner key and list tools, archive rebuild, web releases |

## Run it locally

Requirements: Node 22, pnpm 10, Docker, ffmpeg, exiftool; Foundry for contracts.

```sh
pnpm install && pnpm -r build
docker compose -f infra/dev/docker-compose.yml up -d --wait     # relays, IPFS ×2, Postgres, ArLocal, 2 chains
node scripts/dev-setup.mjs                                      # SAMPLE keys, registry on both chains, signed lists
export OWNER_PUBKEY=$(node -e 'console.log(require("./.dev/config.json").ownerPubkey)')
docker compose -f infra/dev/docker-compose.yml up -d            # relays now enforce the owner's lists
node scripts/e2e.mjs                                            # full end-to-end test (62 checks)
```

To click around: start the API, media worker and publisher the way `scripts/e2e.mjs` does (or `pnpm --filter
@azaadawaaz/web e2e:real`), then `pnpm --filter @azaadawaaz/web dev` and open http://localhost:5173. The sample
owner and moderator keys are in `.dev/keys.json`.

## Checks

`pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` ·
`cd packages/contracts && forge test` · `cd infra/relay && npm test` · `node scripts/e2e.mjs` ·
`pnpm --filter @azaadawaaz/web e2e` · `pnpm --filter @azaadawaaz/web e2e:real`
