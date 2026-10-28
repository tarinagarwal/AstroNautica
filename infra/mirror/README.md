# AzaadAwaaz mirror kit

Anyone can run a copy of AzaadAwaaz that keeps working when the official
domains are blocked (spec §10). One command starts:

| Service | What it does | Port |
|---|---|---|
| `web` | nginx serving the static web app that `sync` exported from IPFS. Strict CSP, no access log, no IP logging | 80 |
| `ipfs` | Kubo 0.38.1 pinning every story, media file and web build in the signed lists; read-only gateway that serves only what it pins | 4001 (swarm), 8080 (gateway) |
| `relay` | strfry with the AzaadAwaaz write policy (NIP-13 proof-of-work and rate limits on comments and reactions), streaming new events from the official relays | 7777 |
| `sync` | `services/mirror-sync`: verifies the owner-signed lists and keeps the three above up to date | none |
| `onion` (optional) | Tor v3 onion service for the mirror, with Tor's PoW DoS defence | none |

## Run a mirror

```sh
git clone <repository> && cd <repository>/infra/mirror
cp .env.example .env
# set OWNER_PUBKEY (check it against two independent sources)
docker compose up -d --build
# optional onion address:
docker compose --profile onion up -d
docker compose exec onion cat /var/lib/tor/hs_web/hostname
```

Put your own TLS terminator in front of port 80 (or only offer the onion
address). Then ask the owner to add your mirror. Mirrors appear in the signed
mirror list only after the owner approves them; clients never trust a mirror
because of where it is hosted, only because every file verifies against the
signed manifests.

## What `sync` does

`sync` is built from `services/mirror-sync`. Every `SYNC_INTERVAL_SECONDS`
(default 10 minutes) it:

1. **Fetches and verifies the signed lists.** It reads the lists (spec §3,
   decisions.md D5) from `BOOTSTRAP_RELAYS`, then from the relays the verified
   relay list names. The owner-signed lists are checked against `OWNER_PUBKEY`;
   moderator-signed lists against the owner-signed moderator list; clients'
   union rules (moderators' lists minus owner overrides) are applied exactly as
   `packages/core` does. Anything that fails verification is ignored and the
   last good copy (in the `sync-state` volume) stays in use.
2. **Updates the web app.** The verified releases list names the web app's
   CID. `sync` pins it on the local Kubo node, exports it to
   `/srv/web/<cid>/`, checks every file against the CID, and atomically
   switches the `/srv/web/current` symlink that nginx serves. Old builds are
   removed after the switch.
3. **Pins the archive.** For every published story (all versions) it pins the
   manifest and every media file by CID on the local node, and unpins only
   what the signed lists remove (for example unlisted stories, if the owner's
   policy says mirrors should drop them).
4. **Fills the relay.** `relay` already follows `UPSTREAM_RELAYS` live through
   `strfry stream`. `sync` backfills history and follows relays added to the
   signed relay list later: it fetches story, version, receipt and list events
   (and comments and reactions) from the official relays and republishes them
   to `LOCAL_RELAY_URL`. Comments and reactions carry their original
   proof-of-work, so the local write policy accepts them; rate limits do not
   apply to relay-to-relay sources.
5. **Reports health** in its log: list versions, CIDs pinned, events copied.
   It never logs client addresses (it has none to log).

Environment the compose file gives `sync`: `OWNER_PUBKEY`,
`BOOTSTRAP_RELAYS`, `BOOTSTRAP_GATEWAYS`, `LOCAL_RELAY_URL`,
`LOCAL_IPFS_API_URL`, `WEB_ROOT`, `STATE_DIR`, `SYNC_INTERVAL_SECONDS`.

Until `services/mirror-sync` exists, start the other services on their own:
`docker compose up -d web ipfs relay` (set `OWNER_PUBKEY` to anything for
now). The relay will stream from `UPSTREAM_RELAYS`; `web` answers 404 until a
build has been exported to `/srv/web/current`.

## Privacy

No service logs client addresses: nginx has `access_log off` and runs with
Docker's `none` log driver, strfry's connect lines are scrubbed and the relay
container also uses the `none` driver, Kubo has no gateway access log.

## Updating and removing

```sh
git pull && docker compose up -d --build     # update
docker compose down                          # stop, keep data
docker compose down -v                       # stop and delete all data
```
