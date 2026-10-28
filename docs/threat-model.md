# Threat model

What AzaadAwaaz defends against, how, and what it cannot do. Spec §12 lists the threats; this document is the
owner's reference when something happens. Runbooks for concrete incidents are in `docs/runbooks/`.

## Assets
1. **Published stories**: must stay readable and verifiable.
2. **Contributors' identities**: must never be revealed by us or by their media.
3. **Unpublished submissions**: private until approved.
4. **Keys**: owner, publisher (Nostr, X25519, EVM), moderators, onion service keys.
5. **Access paths**: domains, onion services, app distribution, relays, gateways.

## 1. The operators themselves (highest risk)
No architecture protects a person under legal or physical pressure. The weakest links are:
- **Payment trails.** Domains, hosting, pinning services, Arweave funding and gas all need payment. Pay with methods
  that don't name the owner where lawful (e.g. privacy-respecting registrars such as Njalla, crypto where accepted)
  and keep registrations outside India (spec §10).
- **Device seizure.** The owner key is offline (paper and encrypted file). Moderator keys are on their devices behind a
  passphrase or app lock. A seized moderator device only exposes that moderator's key: remove them (runbook
  `moderator-removal.md`) and their entries stop counting immediately.
- **Coercion to unpublish.** Published copies can't be erased by anyone, including us; this is stated honestly in the
  UI. Unlisting only hides a story in official clients, and the owner can reverse it.
- **Legal order against an operator.** Operators can comply with an order about *their own* servers without
  affecting other copies: mirrors, public relays, IPFS pins by others and Arweave remain. Keep the operator set small
  and documented, and know which services each person controls.

## 2. Access blocking
| Threat | Defence |
|---|---|
| Domain seizure | Several domains at registrars outside India, never `.in`; the signed mirror list tells clients and readers about new domains; the onion service and the app don't need any domain |
| DNS blocking | App has built-in DoH; IPFS gateways and relays on other domains; onion service |
| IP blocking | Hosts in ≥ 2 providers and ≥ 2 countries; public relays and gateways run by others; Tor with Snowflake/obfs4 bridges in the app |
| CDN or host takedown | No dependency on a single CDN; site works without one; mirror kit lets anyone host a full copy |
| App-store removal | No app store: signed APK distributed via every door, self-updates by verifying the signed release list |
| A relay or gateway blocks us | Clients race several relays and gateways; content is verified by hash, so any gateway works |

## 3. Integrity attacks
| Threat | Defence |
|---|---|
| A gateway or mirror serves altered content | Every file is checked against its SHA-256 (and CID) before display; mismatching sources are skipped and flagged |
| Forged story events | Clients accept story events only from publisher keys on the owner-signed service-keys list, valid at the event time |
| Forged lists | Owner lists must be signed by the pinned owner key; moderator lists count only for currently active moderators; events dated in the future are ignored |
| Compromised publisher key | Owner publishes a new service-keys list with `until` on the old key; events after that time from the old key are rejected; chain registry `setPublisher` rotates the EVM key |
| Compromised moderator | Daily caps on unlisting in clients and the API, owner alerts on every unlisting, owner overrides, instant removal; approvals they made earlier remain valid (they were legitimate at the time) — if they approved bad content, unlist it |
| Tampered manifest bytes | Verify button recomputes the hash, checks the moderator's approval signature over the approval body, and checks the on-chain receipts on every configured chain |
| Event caching bug in libraries | Core never trusts nostr-tools' cached verification; `verifyEventStrict` recomputes id and signature |

## 4. Contributor safety
- Metadata (EXIF, GPS, XMP, IPTC, device, timestamps, MP4 `udta`/`©xyz`/`meta`/`uuid`) is stripped **on the device**
  before upload (`packages/media-strip`), confirmed by re-scanning, and re-checked by the server; the publisher
  refuses to publish an image that still carried metadata.
- No phone numbers, emails or real names; pen names are optional.
- No IP addresses in any log of ours (web server `access_log off`, relays, API logger without remote address).
- Invite links carry the code in the URL fragment, which browsers don't send to servers.
- **Residual risks:** the *content* itself (a face, a voice, a recognisable place or writing style) can identify a
  contributor; moderators should consider this before approving. Network observers can see that someone connects to
  our API; contributors at risk should use Tor (the app's built-in Tor, or Tor Browser for the onion service).

## 5. Unpublished submissions
- Encrypted on the contributor's device; the server stores only ciphertext (secretstream, 1 MiB chunks) and content
  keys sealed to moderators' and the owner's X25519 keys. The publisher gets a key only on approval.
- Nothing is written to IPFS, Arweave, relays or chains before approval.
- Rejected submissions are deleted after 30 days; approved ones after publication.
- Feedback to contributors is NIP-44 encrypted to them. Public audit events carry only a hash of the submission id.
- **Residual risk:** submission metadata (sizes, timing, contributor pubkey) is visible to whoever controls the API
  database.

## 6. Denial of service and spam
- Relays require NIP-13 proof-of-work (default 16 bits) and rate-limit per key; clients also ignore comments without
  enough committed PoW, so spam on public relays doesn't show.
- Moderators can hide comments and mute keys (signed lists).
- The onion service uses Tor's PoW defence; the API rate-limits by key, never by IP.

## 7. Malicious uploads
- Media parsers (ffmpeg, sharp) run as separate processes / worker threads with time and size limits; the media
  service container runs as a non-root user with no network access needed.
- The web app renders Markdown without raw HTML and enforces a strict CSP with no inline scripts.

## Out of scope
- Global passive adversaries correlating Tor traffic.
- Compromise of a contributor's own device before stripping.
- Coerced moderators approving content: approvals are attributable and auditable, not preventable.
