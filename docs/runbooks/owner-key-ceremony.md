# Runbook: owner key ceremony (once, at setup)

The owner key is the root of trust pinned into every client build. Do this on an offline machine.

1. Boot an offline computer (e.g. Tails with networking disabled).
2. Generate the key: `node scripts/gen-owner-key.mjs` — prints the `npub`, writes `owner.nsec.enc` (encrypted with a
   passphrase you choose, Argon2id + XSalsa20-Poly1305) and prints the `nsec` once.
3. Write the `nsec` on paper twice; store the copies in two separate safe places. Keep the encrypted file on two USB
   drives in separate places.
4. Generate the owner's X25519 key in the same session (`--x25519`), also backed up.
5. Copy only the `npub` to the online world: it goes into `apps/web/src/defaults.json` and the Android app config
   before building releases.
6. Sign the first lists (moderators, service-keys, relays, gateways, mirrors, onions) offline and carry the signed
   event file to an online machine on a USB drive; publish it with `scripts/publish-events.mjs`.
7. Never type the `nsec` into an online device.
