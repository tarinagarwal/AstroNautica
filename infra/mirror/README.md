# AzaadAwaaz mirror kit

Anyone can run a copy of AzaadAwaaz that keeps working when the official
domains are blocked (spec §10). One command starts:

| Service | What it does | Port |
|---|---|---|
| `web` | nginx serving the static web app that `sync` exported from IPFS. Strict CSP, no access log, no IP logging | 80 |
| `ipfs` | Kubo 0.38.1 pinning every story, media file and web build in the signed lists; read-only gateway that serves only what it pins | 4001 (swarm), 8080 (gateway) |
| `relay` | strfry with the AzaadAwaaz write policy (stories, lists and audit events only from the owner, moderator and publisher keys; no deletions; NIP-13 proof-of-work and rate limits on comments and reactions; every other kind rejected), streaming new events from the official relays | 7777 |
| `sync` | `services/mirror-sync`: verifies the owner-signed lists and keeps the three above up to date | none |
| `onion` (optional) | Tor v3 onion service for the mirror, with Tor's PoW DoS defence | none |

## Run a mirror

```sh
git clone <repository> && cd <repository>/infra/mirror
cp .env.example .env
# set OWNER_PUBKEY (check it against two independent sources); both `relay`
# and `sync` require it
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
   proof-of-work, so the local write policy accepts them (events that arrive
   through `strfry stream` skip the per-key rate limits; the republished ones
   do not, so a busy thread can take more than one sync cycle to fill).
5. **Reports health** in its log: list versions, CIDs pinned, events copied.
   It never logs client addresses (it has none to log).

Environment the compose file gives `sync`: `OWNER_PUBKEY`,
`BOOTSTRAP_RELAYS`, `BOOTSTRAP_GATEWAYS`, `LOCAL_RELAY_URL`,
`LOCAL_IPFS_API_URL`, `WEB_ROOT`, `STATE_DIR`, `SYNC_INTERVAL_SECONDS`.

Start the services on their own with `docker compose up -d web ipfs relay`
(`OWNER_PUBKEY` must still be the real owner key: the relay uses it). The relay will stream from `UPSTREAM_RELAYS`; `web` answers 404 until a
build has been exported to `/srv/web/current`.

## Relay write policy and the owner key

The relay (`infra/relay`) stores only what AzaadAwaaz needs: stories (kind
30023) from the owner and publisher keys, lists and storage receipts (30078)
from the owner, current moderators and publisher keys, audit events (9737) from
the owner and current moderators, and comments (1111) and reactions (7) from
anyone with proof-of-work. Deletions (kind 5, kind 62), NIP-98 auth events and
every other kind are rejected, whether they come from a client or from an
upstream relay.

It learns the moderator and publisher keys from the owner's signed
`moderators` and `service-keys` lists as they pass through it (newest list
wins; only events signed by `OWNER_PUBKEY` count) and keeps what it learned in
`/app/strfry-db/policy-state.json` in the `relay-db` volume. On a fresh mirror,
events signed by moderators or publishers are refused until the owner's lists
have arrived; `sync` republishes them on its next cycle. To start with the
lists in place, save the owner's current list events (a JSON array, e.g. from
`node scripts/fetch-lists.mjs`) and point `BOOTSTRAP_LIST_EVENTS_FILE` at the
file inside the relay container (mount it read-only); the relay imports them
with `strfry import`, which checks every signature.

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
