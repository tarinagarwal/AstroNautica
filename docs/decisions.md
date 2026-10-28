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
and hashing; `nostr-tools` for NIP-19 encoding and Nostr event handling; `canonicalize` for RFC 8785 JCS.
