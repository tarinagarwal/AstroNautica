# Runbook: rotate the publisher key (suspected compromise or routine)

The publisher service holds three keys: Nostr (signs story events and storage receipts), X25519 (receives content
keys on approval) and EVM (writes chain receipts). Rotate all three together.

1. **Stop the publisher** (`docker compose stop publisher`). Approved submissions wait in the queue; nothing is lost.
2. **Generate new keys** on a clean machine: `node scripts/gen-service-keys.mjs --public publisher-public.json > publisher-keys.json`.
   Only `publisher-public.json` goes to the owner machine. Store the file
   in the secrets store used by the publisher (Docker secret), never in the repository.
3. **Owner signs a new service-keys list** (owner machine, offline key):
   - set `until = <now>` on the old publisher entry (stories it signed *before* now stay valid; anything signed with
     it later is rejected by every client);
   - add the new entry with `from = <now>` and the new Nostr, X25519 and EVM keys.
   `node scripts/owner-sign-list.mjs service-keys --rotate-publisher publisher-public.json`
4. **Vouch for the old key's genuine stories.** Once the old key has `until`, clients accept its story events and
   storage receipts only for manifests the owner vouches for, because a stolen key can backdate `created_at`
   (decision D17). Online: `node scripts/list-publisher-manifests.mjs --publisher <old npub> --evm <old EVM address>
   --before <until> --out manifests.json`, then **review every line** (anything you don't recognise is an attacker's,
   if the key was stolen; delete it from the file). Offline: `node scripts/owner-sign-list.mjs vouched --publisher
   <old npub> --manifests manifests.json --key owner.key.enc --current lists.json --out vouched.json` and publish it
   with the service-keys list. Chain receipts need no vouching: their block time can't be faked, so receipts written
   by the old EVM address before `until` stay valid automatically.
5. **Rotate the EVM publisher on every chain:** from the owner's EVM key (hardware wallet),
   `cast send <registry> "setPublisher(address)" <new address> --rpc-url base` and the same for `bsc`. Fund the new
   address with a little gas on each chain.
6. **Re-wrap pending approvals.** Submissions approved but not yet decrypted have content keys sealed to the old X25519
   key. A moderator re-approves them in the moderator area (it re-wraps for the new key) — the moderator UI lists them
   under "Re-wrap needed".
7. **Start the publisher** with the new secrets and watch `GET /jobs` until the queue drains.
8. If the old key was **compromised**, also check relays for events signed by it after `until` (clients ignore them,
   but note them in `docs/incidents.md`).
