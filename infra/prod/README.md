# Production stack (one host)

`docker-compose.yml` here is the production shape of one AzaadAwaaz host
(spec §10, §11). It is not deployed automatically. Run it on at least two
hosts, with different providers in different countries; each host gets its own
relay, IPFS node and onion service, and they peer with each other.

| Service | Image | Notes |
|---|---|---|
| `web` | built from `infra/prod/web.Dockerfile` (apps/web build + nginx 1.27) | ports 80/443; `nginx.conf`: strict CSP, `access_log off`, no client addresses anywhere; also fronts `/api/`, `relay.<domain>` (wss) and `ipfs.<domain>` |
| `onion` | `osminogin/tor-simple:0.4.9.14` (Tor built with the `pow` module) | two v3 onion services (public site, moderator area with client authorisation) over unix sockets to `web`; `HiddenServicePoWDefensesEnabled 1` (`torrc`) |
| `migrate` | the `api` image, `node dist/migrate.js` | one-shot: applies the migrations as the database owner, then exits; `api` and `publisher` wait for it |
| `api` | built from `services/api/Dockerfile` | `backend` only (postgres, relay); database user `api`; `AUTO_MIGRATE=false` |
| `media` | built from `services/media/Dockerfile`, `node dist/server.js` | the media worker (ffmpeg, sharp) on port 3001; only on the internal `mediabus` network shared with the publisher; uid 1000, read-only root, no capabilities, no secrets, memory/pid limits |
| `volume-perms` | `alpine:3.22` | one-shot: gives uid 1000 the `media-work`, `seed` and `seed-watch` volumes |
| `publisher` | built from `services/publisher/Dockerfile` | the only holder of the publisher key; `backend` + `ipfsrpc` + `mediabus` + outbound; database user `publisher` |
| `relay` | built from `infra/relay` (strfry 1.1.3 + policy) | reached through `web` as `wss://relay.<domain>`; needs `OWNER_PUBKEY` (write allowlist) |
| `ipfs` | `ipfs/kubo:v0.38.1` | server profile, CIDv1, `Gateway.NoFetch` (serves only what we pin); swarm port 4001 published; RPC only on `ipfsrpc`, gateway only on `ipfsgw` |
| `seedbox` | `linuxserver/transmission:4.0.6` | seeds `seed/complete/` from `.torrent` files dropped in the watch volume; peer port 51413 |
| `postgres` | `postgres:16-alpine` | internal network only; password from a Docker secret |

The `services/*/Dockerfile`s are built with the repository root as context
(pnpm workspace).

## First start

```sh
cd infra/prod
cp .env.example .env                 # edit
# create every file listed in secrets/README.md
docker compose build
docker compose up -d
docker compose exec onion cat /var/lib/tor/hs_web/hostname   # the onion address
```

## Networks

| Network | Internet | Members | Why |
|---|---|---|---|
| `edge` | yes (published ports) | web, relay, ipfs, seedbox | what readers reach |
| `backend` | no | postgres, migrate, api, publisher, relay, seedbox, web | the API's world: postgres and the relay, nothing else |
| `ipfsrpc` | no | ipfs, publisher | Kubo's RPC API (5001) controls the node (add, pin, rm, config, shutdown). Kubo binds it to its fixed address on this network (`IPFS_RPC_IP` in `IPFS_RPC_SUBNET`, defaults `172.31.250.2` in `172.31.250.0/29`; change both if that range is taken on the host) and to loopback for the healthcheck, so the api, web and media cannot reach it |
| `ipfsgw` | no | ipfs, web | the read-only gateway (8080) behind `https://ipfs.<domain>` |
| `mediabus` | no | media, publisher | the media worker: untrusted files are parsed in a container with no internet, no database and no secrets |
| `egress` | yes | publisher, onion | Arweave, EVM RPCs, other relays and IPFS nodes; Tor |

## Database users

The database owner (`azaad`, secret `postgres_password`) is used only by the
one-shot `migrate` service. The migrations (`services/api/migrations`, `004_db_roles.sql`)
create two `NOLOGIN` group roles with least-privilege grants, and
`postgres/init-users.sh` creates the `LOGIN` users that use them:

| User | Member of | Can |
|---|---|---|
| `api` (secret `postgres_api_password`) | `azaad_api_role` | read and write the API's tables; the audit and invite tables are append-only; no DDL, no `schema_migrations` |
| `publisher` (secret `postgres_publisher_password`) | `azaad_publisher_role` | `SELECT` submissions and contributors; `UPDATE` only `submissions(state, manifest_sha256, manifest_cid, published_at, updated_at)`; `SELECT`/`UPDATE` publish_jobs; `INSERT` owner_alerts |

`init-users.sh` runs automatically only when the `postgres-data` volume is
created. **On an existing database** (upgrading a host), create the two secret
files, then:

```sh
docker compose up -d postgres
docker compose exec postgres sh /docker-entrypoint-initdb.d/10-azaad-users.sh   # idempotent
docker compose up -d                                                             # runs migrate, then api/publisher
```

Re-running the script also rotates the two passwords after you change the
secret files (then `docker compose up -d --force-recreate api publisher`).

## Relays: owner key and `wss:`

The relay's write policy (`infra/relay/policy.js`) accepts stories, lists and
audit events only from the owner and the moderator/publisher keys the owner's
own signed lists name, rejects deletions (kind 5, kind 62) and every kind
AzaadAwaaz does not use, so `OWNER_PUBKEY` is required. It learns moderators
and publishers from the owner's lists as they arrive and keeps them in
`/app/strfry-db/policy-state.json` (the `relay-db` volume); at every start it
also replays the owner's lists already in its database. A new host's relay
therefore refuses moderator and publisher events until the owner's
`moderators` and `service-keys` lists have reached it: publish (or re-publish)
them to it first, or start it with `BOOTSTRAP_LIST_EVENTS_FILE` pointing at a
mounted JSON array of the owner's list events (imported with `strfry import`,
which checks every signature).

**Every relay URL in the production signed relay list must be `wss://`.** The
relays are reached through nginx (`wss://relay.<domain>`) or, for other
operators' relays, over TLS; `ws://` URLs are for local development only (and
for `.onion` addresses, which Tor already encrypts). The internal `ws://relay:7777`
in this compose file never leaves the `backend` network.

## Onion keys

The vanity address (`azaad…`, made offline with `mkp224o`) is imported once:

```sh
docker compose stop onion
docker run --rm -v azaadawaaz_onion-keys:/var/lib/tor -v "$PWD/azaad-keys:/in:ro" alpine:3.22 sh -c '
  mkdir -p /var/lib/tor/hs_web &&
  cp /in/hs_ed25519_secret_key /in/hs_ed25519_public_key /in/hostname /var/lib/tor/hs_web/ &&
  chown -R 100:101 /var/lib/tor && chmod 700 /var/lib/tor/hs_web'
docker compose start onion
```

Moderators get access to the moderator onion by adding their client public key
as `/var/lib/tor/hs_mod/authorized_clients/<name>.auth`
(`descriptor:x25519:<base32 key>`) and restarting `onion`.

Back up the `onion-keys` volume encrypted, in two places (spec §10).

## TLS

nginx reads `secrets/tls_fullchain.pem` and `secrets/tls_privkey.pem`. Renew
outside the stack (for example certbot with a DNS challenge, or http-01 into
the `acme` volume, which nginx serves at `/.well-known/acme-challenge/`), then
`docker compose restart web`. The onion services do not need certificates.

## Interfaces the services rely on

Environment set by this compose file (the services read these):

- `migrate`, `api`, `publisher`: `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`,
  `DATABASE_PASSWORD_FILE` (each with its own database user, see above)
- `api`: `PORT=3000` (nginx proxies `/api/` to it, path unchanged), `STAGING_DIR`, `AUTO_MIGRATE=false`,
  `MAX_SUBMISSION_BYTES`, `MAX_CONTRIBUTOR_STAGING_BYTES`, `MAX_MEDIA_PER_SUBMISSION`, `DRAFT_RETENTION_DAYS`
- `relay`: `OWNER_PUBKEY` (plus the PoW/rate settings)
- `media`: `MEDIA_PORT=3001`, `MEDIA_SHARED_DIR=/var/lib/azaadawaaz/media` (the `media-work` volume); nothing else
- `ipfs`: `IPFS_API_LISTEN` (where the RPC listens, see Networks)
- `publisher`: `MEDIA_URL=http://media:3001`, `MEDIA_SHARED_DIR=/var/lib/azaadawaaz/media` (same volume), `PUBLISHER_NOSTR_KEY_FILE`, `PUBLISHER_X25519_KEY_FILE`,
  `ARWEAVE_URL`, `ARWEAVE_WALLET_FILE`, `EVM_PRIVATE_KEY_FILE`,
  `EVM_RPC_URLS` (`chainId=url,...`), `REGISTRY_ADDRESSES`
  (`chainId=address,...`), `RELAYS`, `IPFS_API_URLS`, `SEEDBOX_WATCH_DIR`,
  `SEEDBOX_DATA_DIR`, `SEEDBOX_RPC_URL`, `SEEDBOX_RPC_USER`,
  `SEEDBOX_RPC_PASSWORD_FILE`

Seeding contract: write the finished file to `SEEDBOX_DATA_DIR/<name>`, then
put the `.torrent` (whose name is `<name>`) into `SEEDBOX_WATCH_DIR` by writing
it elsewhere and renaming it in. The `.torrent` must be readable by uid 1000
(the seedbox's user), e.g. mode 0644. Transmission verifies the data, renames
the file to `.torrent.added` and seeds. (Checked locally: a 3 MB file came up
at 100% / Done this way.)

## Logging

No service logs client addresses (spec §12). `web`, `relay`, `onion` and
`seedbox` additionally use Docker's `none` log driver; the others keep small
rotated JSON logs.

## Security headers

Every nginx server block sends security headers. The app servers (clearnet and
onion) use `azaad-headers.conf` (strict CSP, nosniff, `X-Frame-Options: DENY`,
COOP/CORP, no referrer, HSTS on clearnet). `relay.<domain>` and the port-80
redirect send `default-src 'none'; frame-ancestors 'none'`, nosniff and no
referrer. `ipfs.<domain>` serves arbitrary pinned bytes, so every response
carries `Content-Security-Policy: sandbox; default-src 'none'` and
`X-Content-Type-Options: nosniff` (Kubo's own CSP is dropped): an HTML or SVG
file in a CID cannot run script with that origin. The web app is unaffected:
it `fetch()`es from gateways and checks every file against its hash.
