# Production stack (one host)

`docker-compose.yml` here is the production shape of one AzaadAwaaz host
(spec §10, §11). It is not deployed automatically. Run it on at least two
hosts, with different providers in different countries; each host gets its own
relay, IPFS node and onion service, and they peer with each other.

| Service | Image | Notes |
|---|---|---|
| `web` | built from `infra/prod/web.Dockerfile` (apps/web build + nginx 1.27) | ports 80/443; `nginx.conf`: strict CSP, `access_log off`, no client addresses anywhere; also fronts `/api/`, `relay.<domain>` (wss) and `ipfs.<domain>` |
| `onion` | `osminogin/tor-simple:0.4.9.14` (Tor built with the `pow` module) | two v3 onion services (public site, moderator area with client authorisation) over unix sockets to `web`; `HiddenServicePoWDefensesEnabled 1` (`torrc`) |
| `api` | built from `services/api/Dockerfile` | internal network only |
| `media` | built from `services/media/Dockerfile` | internal network only, read-only, no capabilities, memory/pid limits |
| `publisher` | built from `services/publisher/Dockerfile` | the only holder of the publisher key; internal + outbound network |
| `relay` | built from `infra/relay` (strfry 1.1.3 + policy) | reached through `web` as `wss://relay.<domain>` |
| `ipfs` | `ipfs/kubo:v0.38.1` | server profile, CIDv1, `Gateway.NoFetch` (serves only what we pin); swarm port 4001 published |
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

- all: `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`,
  `DATABASE_PASSWORD_FILE`
- `api`: `PORT=3000` (nginx proxies `/api/` to it, path unchanged), `STAGING_DIR`
- `media`: `STAGING_DIR`, `SEED_DIR`
- `publisher`: `PUBLISHER_NOSTR_KEY_FILE`, `PUBLISHER_X25519_KEY_FILE`,
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
