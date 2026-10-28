# mirror-sync

The sync job of the mirror kit (`infra/mirror`). See `infra/mirror/README.md` for what it does. It reuses the
archive rebuild logic in `scripts/lib/archive.mjs`: every list, manifest and file is verified before it is pinned or
served.

| Variable | Meaning |
|---|---|
| `OWNER_PUBKEY` | Trust anchor (owner npub or hex) |
| `BOOTSTRAP_RELAYS` | Comma-separated relays to start from |
| `BOOTSTRAP_GATEWAYS` | Comma-separated IPFS gateways (trustless CAR responses) |
| `LOCAL_RELAY_URL` / `LOCAL_IPFS_API_URL` | The mirror's own relay and Kubo RPC |
| `WEB_ROOT` | Where web releases are exported; nginx serves `WEB_ROOT/current` |
| `STATE_DIR` | Last good copy of the verified lists |
| `SYNC_INTERVAL_SECONDS` | Default 600 |
| `CHAINS` | Optional JSON `[{ key, rpc, registry }]` to also find superseded versions via chain receipts |
| `ARWEAVE_URL` | Optional Arweave gateway fallback |

Run once against the dev network: `OWNER_PUBKEY=<hex> BOOTSTRAP_RELAYS=ws://127.0.0.1:7777 BOOTSTRAP_GATEWAYS=http://127.0.0.1:8080 LOCAL_RELAY_URL=ws://127.0.0.1:7778 LOCAL_IPFS_API_URL=http://127.0.0.1:5002 WEB_ROOT=/tmp/web STATE_DIR=/tmp/state node src/main.mjs --once`
