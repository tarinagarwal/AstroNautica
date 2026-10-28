# Production secrets

Each file below is mounted into the containers that need it as a Docker
secret (`/run/secrets/<name>`), never as an environment variable. This
directory is git-ignored except for this README. Create the files on the host
with mode `0600`, owned by the deploying user, and keep the encrypted backups
described in the runbooks.

Write every file **without a trailing newline** (for example
`openssl rand -hex 32 | tr -d '\n' > postgres_password`): some consumers, such
as the seedbox's `FILE__PASS`, use the bytes verbatim.

| File | Secret name | Used by | Contents |
|---|---|---|---|
| `postgres_password` | `postgres_password` | postgres, api, media, publisher | random password, e.g. `openssl rand -base64 32` |
| `publisher_nostr_key` | `publisher_nostr_key` | publisher only | the publisher's Nostr secret key (64 hex chars). Rotatable (spec §12) |
| `publisher_x25519_key` | `publisher_x25519_key` | publisher only | the publisher's X25519 staging-decryption key (decisions.md D1, D2) |
| `arweave_wallet.json` | `arweave_wallet` | publisher only | Arweave wallet JWK |
| `evm_private_key` | `evm_private_key` | publisher only | key that pays for receipts on every configured chain |
| `seedbox_rpc_password` | `seedbox_rpc_password` | seedbox, publisher | Transmission RPC password |
| `tls_fullchain.pem` | `tls_fullchain` | web | certificate chain for every domain (SANs incl. `relay.` and `ipfs.` names) |
| `tls_privkey.pem` | `tls_privkey` | web | its private key |

The owner key is never on a server. The onion service keys are not here: they
live in the `onion-keys` volume (see `../README.md`).
