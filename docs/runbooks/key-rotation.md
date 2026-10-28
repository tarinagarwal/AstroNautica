# Runbook: rotate the publisher key (suspected compromise or routine)

The publisher service holds three keys: Nostr (signs story events and storage receipts), X25519 (receives content
keys on approval) and EVM (writes chain receipts). Rotate all three together.

1. **Stop the publisher** (`docker compose stop publisher`). Approved submissions wait in the queue; nothing is lost.
2. **Generate new keys** on a clean machine: `node scripts/gen-service-keys.mjs > publisher-keys.json`. Store the file
   in the secrets store used by the publisher (Docker secret), never in the repository.
3. **Owner signs a new service-keys list** (owner machine, offline key):
   - set `until = <now>` on the old publisher entry (stories it signed *before* now stay valid; anything signed with
     it later is rejected by every client);
   - add the new entry with `from = <now>` and the new Nostr, X25519 and EVM keys.
   `node scripts/owner-sign-list.mjs service-keys --rotate-publisher publisher-keys.json`
4. **Rotate the EVM publisher on every chain:** from the owner's EVM key (hardware wallet),
   `cast send <registry> "setPublisher(address)" <new address> --rpc-url base` and the same for `bsc`. Fund the new
   address with a little gas on each chain.
5. **Re-wrap pending approvals.** Submissions approved but not yet decrypted have content keys sealed to the old X25519
   key. A moderator re-approves them in the moderator area (it re-wraps for the new key) — the moderator UI lists them
   under "Re-wrap needed".
6. **Start the publisher** with the new secrets and watch `GET /jobs` until the queue drains.
7. If the old key was **compromised**, also check relays for events signed by it after `until` (clients ignore them,
   but note them in `docs/incidents.md`).
