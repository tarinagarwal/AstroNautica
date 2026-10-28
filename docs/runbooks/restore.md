# Runbook: restore after losing servers

Published content does not live only on our servers, so it can always be rebuilt from public networks.

1. **Provision** new hosts (two providers, two countries) and run `infra/prod` (`docker compose up -d`).
2. **Restore secrets** from the encrypted backups: publisher keys, onion service keys (two backup locations), TLS.
   The onion address is derived from its key, so restoring the key restores the address.
3. **Restore the database** from the latest encrypted backup if you have one (it holds only unpublished submissions,
   the audit log and job state). Without a backup, unpublished submissions are lost; contributors resubmit.
4. **Rebuild the public archive** into the new IPFS nodes and relays:
   `node scripts/rebuild-archive.mjs --relays <public relays> --gateways <public gateways> --arweave https://arweave.net --pin-to <new ipfs api>`.
   It reads all story events from public relays, fetches every manifest and file (verifying hashes), re-pins them on
   our nodes and re-publishes the events to our relays. CI runs the same script nightly against the real networks.
5. **Check** with the Verify button on a few stories from each era and confirm the home page lists everything.
