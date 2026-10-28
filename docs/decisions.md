# Decisions

Each entry records a choice the spec left open ("decide") or a change to the spec agreed with the owner.

## D1. Staging encryption: separate X25519 keys
Nostr keys (secp256k1) can't be used with libsodium sealed boxes. Moderators, the owner and the publisher each hold an
X25519 encryption key, published next to their `npub` in owner-signed lists. (Spec §3, §5.2.)

## D2. Approval re-wraps the content key for the publisher
On approval, the moderator's client wraps the submission's content key for the publisher's X25519 key. The publisher
holds no key to unapproved submissions. (Spec §5.2.)

## D3. Arweave IDs live in a storage receipt, not the manifest
Arweave can finish after publication and the manifest can't contain its own Arweave ID. A publisher-signed storage
receipt (Nostr kind 30078) maps each SHA-256 to its Arweave transaction. (Spec §4.2, §6.)

## D4. Approval signature covers the approval body
Moderators sign the SHA-256 of the JCS-canonical manifest with the approval fields and post-approval derived fields
removed. `approvalBody()` in `packages/schema` is the only implementation. (Spec §4.2.)

## D5. Two-tier signed lists
The owner signs the rarely-changing lists (moderators, service keys, relays, gateways, mirrors, onions, releases,
overrides). Moderators sign contributors, unlisted, hidden, muted and featured; clients union them across current
moderators minus owner overrides. The offline owner key is never needed for daily moderation. (Spec §3.)

## D6. Video readiness and the 2-minute target
The 2-minute target applies to stories without video, and to stories with video from the end of transcoding. (Spec §5.1,
§16.)

## D7. Receipts on several chains: Base and BNB Smart Chain
The owner asked about BSC. Receipts go to every configured EVM chain; the defaults are Base (cheap, good tooling,
inherits Ethereum's forced-inclusion path) and BNB Smart Chain (cheap, large user base in India, but a small validator
set closely tied to Binance). Using both means neither chain is a single point of failure. More chains are a config
change. (Spec §6, §9.)

## D8. Monorepo tooling
pnpm workspaces, TypeScript (strict, ESM), Vitest for tests. Node 22.

## D9. Crypto libraries
`@noble/curves` and `@noble/hashes` (audited, pure JS, work in browsers, React Native and Node) for Schnorr signatures
and hashing; `nostr-tools` for NIP-19 encoding and Nostr event handling; RFC 8785 JCS is implemented in `packages/schema` (small, tested against the RFC vectors). Metadata validation is hand-written instead of Ajv, because Ajv compiles schemas with `new Function`, which a strict CSP forbids.

## D10. Arweave uploads with arweave-js directly
Spec §6 step 4 offered a bundling service (ArDrive Turbo) or arweave-js. arweave-js works unchanged against ArLocal
(tests) and mainnet, needs no third-party account, and uploads are made idempotent by looking up our own wallet's
transactions by the `Content-SHA256` tag. Turbo can be added later behind the same `ArweaveStore` interface.

## D11. Pinning through the standard IPFS Pinning Service API
Filebase, Pinata and 4EVERLAND all implement it, so the provider is a configuration entry
(`PINNING_SERVICES=[{name, endpoint, token}]`), swappable without code changes. Production refuses to start without
one; development runs without (recorded as skipped in the job).

## D12. Publisher step order: publish first, archive after
Order: decrypt → checks → media → ipfs → pin → torrent → manifest → nostr (story is now `published`) → chain receipts
→ arweave → storage receipt → finalize. Spec §5.1 allows Arweave and the chain receipt to finish after publication;
chain receipts go first because they are fast and power the Verify badge.

## D13. The publisher refuses images whose server re-check changes their bytes
The approved image hash must be the published original. If the server's metadata check would change the bytes, the
on-device stripping missed something; publishing a different file would break the approval, so the job fails and the
owner is alerted instead.

## D14. Mirrors take web releases from the signed releases list
`releases` entries can be `platform: "web"` with the build's IPFS CID; the mirror kit exports the newest one.

## D15. Rebuild uses chain receipts to find superseded versions
Relays keep only the newest version of a replaceable story event. Every version's manifest CID is in the registry's
`Published` logs, so the rebuild script reads them on every configured chain. IPFS content is fetched as CAR files
from trustless gateways and every block is hash-checked, with the DAG walked for completeness.

## D16. Owner key files use Argon2id
`scripts/gen-owner-key.mjs` encrypts with libsodium `crypto_pwhash` (Argon2id, moderate limits) and secretbox.

## D17. Retired publisher keys count only for vouched manifests
A Nostr event's `created_at` is chosen by its signer, so a stolen publisher key could backdate new events to before its
`until`. Once a publisher key has `until`, clients accept its story events and storage receipts only for manifests in
the owner-signed `vouched` list (`scripts/list-publisher-manifests.mjs` + `owner-sign-list.mjs vouched`). Chain
receipts don't need this: their block time can't be faked (D19). (Security review #2.)

## D18. Moderator list caps can't be dodged by backdating
Moderators write each entry's `addedAt`. Effective time = clamp(addedAt, moderator's `from`, event time), raised to
when this client first saw the entry (clients with storage persist "first seen"); a total cap per moderator per list
applies regardless (unlisted 100, hidden 5000, muted 2000, featured 100, revoked-contributors 100). The publisher
decides contributor revocation from the API database (owner action), not from any moderator's signed list.
(Security review #4.)

## D19. Registry receipts are stored per writer
`receipt(storyId, version, by)`; `Published` indexes the publisher address. A retired or compromised key can't squat a
version or block corrections, and clients trust a receipt only if `by` was the publisher EVM key on the signed list
at the receipt's block time. Versions no longer need to increase strictly. (Security review #10.)

## D20. Relays store only what the platform needs
Our relays reject deletion (kind 5) and vanish (62) requests, accept stories and lists only from owner, publisher and
moderator keys, audit events only from moderators, comments and reactions only with proof-of-work, and nothing else.
(Security review #3, #6.)

## D21. Media parsers run in an isolated container
ffmpeg and libvips run in the `media` worker (no secrets, no internet, own user), reached by the publisher over an
internal network and a shared volume. The publisher refuses to start in production without `MEDIA_URL`.
(Security review #7.)

## D22. The publisher re-proves a manifest before signing anything
Before the story event, chain receipts and Arweave uploads, the publisher re-checks the manifest against the
submission row and the moderator's approval signature, so database access alone can't get content signed. Policy
failures (revoked contributor, removed moderator, tampered body) block the job and wipe the work directory instead of
retrying forever. (Security review #5, #8, #14.)
