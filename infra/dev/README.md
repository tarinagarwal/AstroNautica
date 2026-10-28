# Local development network

The local network that `services/*`, `apps/web` and the end-to-end and
rebuild tests use (spec §11, §15). It gives you two Nostr relays with our write
policy, two peered IPFS nodes, PostgreSQL, an Arweave test environment and two
EVM chains. Everything listens on `127.0.0.1` only.

Requirements: Docker Engine 25+ with Compose v2. The first `up` builds two
small images (`azaadawaaz/relay:dev`, `azaadawaaz/anvil:dev`).

## Commands

Run from the repository root.

| What | Command |
|---|---|
| Start (build if needed) | `docker compose -f infra/dev/docker-compose.yml up -d --build --wait` |
| Status | `docker compose -f infra/dev/docker-compose.yml ps -a` |
| Logs | `docker compose -f infra/dev/docker-compose.yml logs -f relay-a` |
| Stop, keep data | `docker compose -f infra/dev/docker-compose.yml down` |
| Reset (stop and wipe all data) | `docker compose -f infra/dev/docker-compose.yml down -v` |
| Reset one service, e.g. relay-a | `docker compose -f infra/dev/docker-compose.yml rm -sf relay-a && docker volume rm azaadawaaz-dev_relay-a-db && docker compose -f infra/dev/docker-compose.yml up -d relay-a` |
| Relay policy smoke test | `node infra/relay/scripts/pow-smoke.mjs` |
| Relay policy unit tests | `cd infra/relay && npm test` |

`--wait` returns (exit 0) once every service is healthy, so CI can run tests
straight after it. `ipfs-peering` is a small sidecar that peers the two IPFS
nodes and re-peers them if one is restarted or reset.

Data lives in named Docker volumes (`azaadawaaz-dev_*`), never in the
repository.

## Ports

| Service | Host address | What it is |
|---|---|---|
| relay-a | `ws://127.0.0.1:7777` | strfry 1.1.3 + AzaadAwaaz write policy |
| relay-b | `ws://127.0.0.1:7778` | second relay, same policy |
| ipfs-a | `http://127.0.0.1:5001` (RPC API), `http://127.0.0.1:8080` (gateway) | Kubo 0.38.1 |
| ipfs-b | `http://127.0.0.1:5002` (RPC API), `http://127.0.0.1:8081` (gateway) | Kubo 0.38.1, peered with ipfs-a |
| postgres | `127.0.0.1:5432` | PostgreSQL 16, databases `azaadawaaz` and `azaadawaaz_test` |
| arlocal | `http://127.0.0.1:1984` | ArLocal 1.1.66 (Arweave test environment) |
| anvil | `http://127.0.0.1:8545` | Anvil, chain id **31337** (stands in for Base) |
| anvil-bsc | `http://127.0.0.1:8546` | Anvil, chain id **97** (stands in for BNB Smart Chain, decisions.md D7) |

Override any host port in `infra/dev/.env` (see `.env.example`).

### Connection settings for services and tests

```
DATABASE_URL=postgres://azaad:azaad@127.0.0.1:5432/azaadawaaz        # DEV ONLY credentials
TEST_DATABASE_URL=postgres://azaad:azaad@127.0.0.1:5432/azaadawaaz_test
RELAYS=ws://127.0.0.1:7777,ws://127.0.0.1:7778
IPFS_API_URLS=http://127.0.0.1:5001,http://127.0.0.1:5002
IPFS_GATEWAYS=http://127.0.0.1:8080,http://127.0.0.1:8081
ARWEAVE_URL=http://127.0.0.1:1984
EVM_RPC_URLS=31337=http://127.0.0.1:8545,97=http://127.0.0.1:8546
```

The `azaad/azaad` PostgreSQL login exists only for this local network. Production
reads its password from a Docker secret (`infra/prod`).

Anvil starts with its standard funded test accounts (the well-known
`test test ... junk` mnemonic, first key
`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`). These keys
are public; never use them on a real chain.

## What is configured

**Relays** (`infra/relay`): strfry with `maxEventSize` 512 KiB (long-form
kind 30023 stories), and the Node write-policy plugin `infra/relay/policy.js`:

- kinds 1111 (comment) and 7 (reaction) need NIP-13 proof-of-work: the event id
  must have at least `POW_DIFFICULTY` leading zero bits (default 16) and the
  `nonce` tag must commit to a target of at least that much;
- per-pubkey limits over a sliding minute: 10 comments, 60 reactions
  (`RATE_COMMENTS_PER_MINUTE`, `RATE_REACTIONS_PER_MINUTE`);
- comments at most 2,000 characters (`MAX_COMMENT_CHARS`);
- every other kind is accepted;
- events arriving from other relays (`strfry stream`/`sync`/`router`) still need
  PoW but skip rate limits.

Rejections use NIP-01 prefixes (`pow:`, `rate-limited:`, `invalid:`), so clients
can show the reason.

**No IP logging:** the plugin never reads the client address strfry hands it;
strfry's own connect/disconnect lines are passed through `scrub-ips.js`, which
replaces every IPv4/IPv6 address with `[ip]`; message dumps and invalid-event
logging are off. Kubo has no gateway access log. ArLocal runs with
`--hidelogs`. PostgreSQL runs with `log_connections=off`.

**IPFS:** `Import.CidVersion=1`; no public bootstrap peers, no AutoConf, no
delegated routing, no mDNS, so the two nodes form a closed network and find
each other through `Peering.Peers` (written and kept current by `ipfs-peering`). Content added
to one node can be fetched from the other's gateway. The RPC API allows CORS
from the Vite dev server origins (`localhost:5173`, `localhost:4173`).

**Chains:** both Anvil instances automine (a block per transaction) and save
their state to their volume (`--state`, every 30 s and on shutdown), so a
restart keeps receipts consistent with what the relays and IPFS hold.
`down -v` gives you fresh chains.

**ArLocal** persists to its volume as well. Mine a block in tests with
`GET http://127.0.0.1:1984/mine`.

## Verify by hand

```sh
curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:7777/      # NIP-11
curl -s -X POST http://127.0.0.1:5001/api/v0/id                         # Kubo
curl -s -X POST http://127.0.0.1:5001/api/v0/swarm/peers                # ipfs-b listed
curl -s http://127.0.0.1:1984/info                                      # ArLocal
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  http://127.0.0.1:8546                                                 # 0x61 = 97
pg_isready -h 127.0.0.1 -p 5432 -U azaad -d azaadawaaz
```
