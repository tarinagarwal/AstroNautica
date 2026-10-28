# publisher

The idempotent publishing pipeline (spec §6; step order in `docs/decisions.md` D12). It claims approved jobs from
Postgres (`FOR UPDATE SKIP LOCKED`), decrypts the submission with the content key the approving moderator sealed for
it, re-checks everything, processes media (`@azaadawaaz/media`), stores files on every own Kubo node, asks pinning
services to pin, creates torrents for videos, builds and stores the manifest, publishes the story event to every
official relay (story is now `published`), writes receipts on every configured chain, uploads to Arweave, publishes
the storage receipt and cleans up staging. Each step's result is saved, so a retry resumes where it stopped.

## Configuration

Environment variables (development falls back to `.dev/config.json` and `.dev/keys.json` from `scripts/dev-setup.mjs`).
Secrets can be given as Docker secret files with `<NAME>_FILE` for the names marked *secret*.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` *secret* (or `DATABASE_HOST/PORT/NAME/USER` + `DATABASE_PASSWORD` *secret*) | Postgres shared with the API |
| `STAGING_DIR` | Encrypted staging store shared with the API |
| `WORK_DIR`, `SEED_DIR` | Work files; torrent + files for the seed box (readable by uid 1000) |
| `OWNER_PUBKEY`, `RELAYS`, `BOOTSTRAP_LIST_EVENTS` | Trust anchor and where to read the signed lists |
| `PUBLISHER_NSEC` *secret* | Signs story events and storage receipts |
| `PUBLISHER_X25519_PRIVATE` *secret* | Opens content keys sealed on approval |
| `PUBLISHER_EVM_KEY` *secret* | Writes chain receipts (fund it with gas on every chain) |
| `IPFS_APIS` | Comma-separated Kubo RPC URLs (production: ≥ 2) |
| `IPFS_GATEWAYS` | Public gateway base URLs, used as torrent web seeds |
| `PINNING_SERVICES` *secret* | JSON `[{ "name", "endpoint", "token" }]`, IPFS Pinning Service API (production: ≥ 1) |
| `ARWEAVE_URL`, `ARWEAVE_JWK` | Arweave node and wallet file |
| `ARWEAVE_MAX_VIDEO_BYTES` | Upload full videos to Arweave up to this size (0 = never) |
| `CHAINS` | JSON `[{ "key", "chainId", "rpc", "registry" }]` |
| `REQUIRED_RELAY_SUCCESSES` | Relays that must accept the story event (default 3) |
| `POLL_MS`, `WORKER_ID` | Worker tuning |

## Run and test
```sh
pnpm --filter @azaadawaaz/publisher build && pnpm --filter @azaadawaaz/publisher start
pnpm --filter @azaadawaaz/publisher test      # unit tests
node scripts/e2e.mjs                          # full pipeline on the dev network (62 checks)
```
