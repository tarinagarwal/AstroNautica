# AzaadAwaaz: product and technical specification

> **For the builder (Claude Code):** this document is the source of truth for what to build. Read it fully before
> writing code. Where it says "decide", pick the simplest option that meets the requirement and record the decision in
> `docs/decisions.md`. Ask the owner before changing any rule marked **MUST**.

## 1. What AzaadAwaaz is

AzaadAwaaz ("free voice") is a **news and media platform that cannot be taken down or fully blocked**.

- **Invited contributors** publish stories made of any mix of text, images and video.
- Every story goes to a **moderation queue** first. **One approval from any moderator publishes it.**
- Once published, a story is stored across several independent networks (IPFS, Arweave, BitTorrent, Nostr relays) and
  gets a tamper-proof receipt on a blockchain. No single company, server or domain holds the only copy, so no single
  order, block or seizure can remove it.
- Readers can read and watch, **comment and react**, in **English and Hindi**, through many doors: a normal website on
  several domains, a Tor onion service, and an Android app distributed outside the app stores.

### 1.1 Principles (all MUST)
1. **No single point of failure** for content, identity or access. Losing any one server, domain, relay or gateway must
   not make published content unreachable.
2. **Nothing becomes permanent before approval.** Submissions stay private and encrypted until a moderator approves
   them. Arweave and IPFS are only written after approval.
3. **Protect contributors.** Strip all metadata (GPS, device, timestamps) from media on the contributor's device before
   upload. Do not require phone numbers, emails or real names. Do not log IP addresses on our servers.
4. **Everything published is verifiable.** Every file is content-addressed (its link is its hash) and every story is
   signed. Any copy from anywhere can be checked against the original.
5. **Readers never depend on one access path.** Clients try several gateways, relays and transports automatically.
6. **Bilingual from day one.** All UI is in English and Hindi; stories can be in either language or both.

### 1.2 Out of scope
- Paid subscriptions, ads, tracking or analytics of any kind.
- iOS app. Apple's store can be ordered to remove it; the website works on iPhones.
- Storing whole videos on a blockchain (too expensive; only hashes go on-chain).

## 2. Roles

| Role | How they get in | Can do |
|---|---|---|
| **Owner** | Holds the owner key (created at setup) | Everything a moderator can, plus: add and remove moderators, issue and revoke contributor invites, sign the official lists (relays, gateways, mirrors, moderators), unlist any story |
| **Moderator** | Added by the owner (their public key is put on the signed moderator list) | Review the queue: approve, reject with a reason, or request changes; hide comments; unlist stories they or others approved |
| **Contributor** | Redeems an invite from the owner | Create, edit and submit stories; see their submissions' status and moderator feedback; edit and resubmit |
| **Reader** | Anyone; optional key generated in the app or browser to comment or react | Read, watch, share, verify; comment and react (with a key) |
| **Mirror host** | Anyone running the mirror kit | Serve copies of all published content and the web client |

There can be **any number of moderators** (`n ≥ 1`). **The first approval publishes the story; there is no voting.**

## 3. Identity and keys

- Every person is identified by a **Nostr key pair** (secp256k1; shown as `npub…`, secret as `nsec…`, per NIP-19).
  No accounts, passwords or phone numbers.
- **Owner key:** created at setup, kept offline (paper backup plus encrypted file), used only to sign official lists
  and invites.
- **Publisher key:** a separate key used by the publishing service to sign published stories. If it is compromised,
  the owner signs a rotation notice and a new key takes over.
- **Moderator keys:** each moderator holds their own key in the app (Android Keystore) or browser (encrypted with a
  passphrase in IndexedDB). Their approvals are signed with it.
- **Encryption keys (X25519):** Nostr keys are secp256k1 and can't be used with libsodium sealed boxes, so every
  moderator, the owner and the publisher service also hold a separate **X25519 encryption key**. Its public half is
  listed next to the person's `npub` in the signed moderator list (and, for the owner and publisher, in the signed
  service-keys list). Only these keys are used for staging encryption (§5.2).
- **Contributor keys:** created when an invite is redeemed. The contributor's public key is added to the signed
  contributor list.
- **Reader keys:** created on demand the first time a reader comments or reacts. Readers can export the key to keep
  their identity.
- **Official signed lists** (Nostr replaceable events plus copies on IPFS and Arweave). They come in two tiers so the
  offline owner key is never a bottleneck for day-to-day moderation:
  - **Owner-signed (rarely change):** moderators (with their X25519 keys), service keys (publisher Nostr, EVM and
    X25519 keys), relays, gateways, mirror domains, onion addresses, signed app releases and **overrides** (entries
    that cancel a moderator action, e.g. re-listing a story a moderator unlisted).
  - **Moderator-signed (change often):** contributors (additions and revocations), unlisted stories, hidden comments,
    muted keys and featured stories. Each moderator publishes their own copy of each list; clients take the **union**
    of the lists signed by everyone currently on the owner-signed moderator list, minus the owner's overrides. When a
    moderator is removed, their entries stop counting.
  - The owner key is pinned in every client build. Clients trust nothing that doesn't chain back to it.

### 3.1 Invites
1. The owner creates an invite: a one-time code (QR and link) signed by the owner key, with optional expiry and note.
2. The contributor opens it in the app or website. A key pair is created on their device, and the invite plus their
   public key go to the API.
3. The API checks the owner's signature and that the code is unused, then records the contributor. The redemption is
   signed by the contributor's new key, so the chain *owner-signed invite → contributor-signed redemption* is
   independently verifiable. A moderator's client adds them to that moderator's signed contributor list
   automatically on its next sync; no owner action is needed.
4. The owner can revoke a contributor at any time. Revoked contributors can't submit; their published stories stay.

## 4. Stories: the content model

A **story** is a title plus an ordered list of **blocks** in any combination:

| Block | Contents |
|---|---|
| `text` | Markdown (headings, bold, italic, links, quotes, lists). No raw HTML. |
| `image` | 1–20 images with an optional caption each (a gallery when more than one) |
| `video` | 1 video with an optional title and description |
| `embed-story` | A reference to another published AzaadAwaaz story |

Story-level fields:
- `language`: `en`, `hi` or `both`. With `both`, every text field has `en` and `hi` values, and readers can switch.
- `title`, `summary` (≤ 300 characters), `cover` (an image from the story or uploaded separately), `tags` (≤ 10),
  `location` (optional free text, never GPS), `contributorDisplayName` (optional pen name; default "AzaadAwaaz
  contributor").
- `version` and `supersedes` (the previous version's manifest hash, for corrections; see §6.5).

Allowed combinations: **any**. Valid examples include text only; one image with a caption; one video with a
description; an article with videos and galleries between paragraphs; and only videos. A story needs at least one
block plus a title.

### 4.1 Media processing (on the contributor's device first, then on the server)
- **On device, before upload (MUST):** strip EXIF, XMP and IPTC from images (re-encode images to drop every
  metadata segment). For videos, **remux without re-encoding** (`-c copy -map_metadata -1 -map_chapters -1`, dropping
  data and subtitle streams and location atoms such as `©xyz`); a full re-encode of a long video is too heavy for a
  phone or browser. The server transcodes after approval (and strips again). Show the contributor a "metadata
  removed ✓" confirmation only after re-reading the output and confirming no metadata remains.
- **On the server, after approval:**
  - Images: WebP at 480, 960 and 1600 px, plus the original (metadata already stripped). Generate a blurhash
    placeholder.
  - Videos: an HLS ladder (360p, 720p, 1080p if the source allows) and an MP4 fallback at 720p, plus a poster frame
    and a short preview. Each HLS playlist and segment is content-addressed.
- **Limits (configurable):** 20 MB per image, 2 GB per video, 60 minutes per video, 100 blocks per story.

### 4.2 Story manifest (what actually gets published)
A JSON document, canonicalised (RFC 8785 JCS) and content-addressed:
```json
{
  "schema": "azaadawaaz/story@1",
  "id": "<stable story id: uuid v7>",
  "version": 1,
  "supersedes": null,
  "language": "both",
  "title": { "en": "...", "hi": "..." },
  "summary": { "en": "...", "hi": "..." },
  "cover": { "cid": "bafy...", "sha256": "...", "variants": { "480": "bafy...", "960": "bafy..." } },
  "tags": ["..."],
  "contributor": { "pubkey": "npub...", "displayName": "..." },
  "blocks": [
    { "type": "text", "markdown": { "en": "...", "hi": "..." } },
    { "type": "image", "items": [ { "cid": "bafy...", "sha256": "...", "width": 1600, "height": 900, "blurhash": "...", "caption": { "en": "...", "hi": "..." } } ] },
    { "type": "video", "source": { "sha256": "<original upload>" }, "hls": "bafy.../master.m3u8", "mp4": { "cid": "bafy...", "sha256": "..." }, "magnet": "magnet:?xt=...", "poster": { "cid": "bafy..." }, "durationSec": 312, "title": { "en": "..." }, "description": { "en": "..." } }
  ],
  "approval": { "moderator": "npub...", "approvedAt": "2026-11-01T10:00:00Z", "signature": "<moderator's signature over the content hash>" },
  "publishedAt": "2026-11-01T10:01:12Z",
  "publisher": "npub..."
}
```
The manifest is stored on IPFS and Arweave. Its IPFS CID and SHA-256 are what the Nostr event and the on-chain receipt
point to.

**The manifest contains no Arweave transaction IDs.** Arweave uploads can finish after the story is published, and the
manifest itself goes to Arweave, so it can't contain its own ID. Arweave locations are published separately as a
**storage receipt** (§6, step 7b): a Nostr event signed by the publisher key mapping each `sha256` to its Arweave
transaction. Because every file is checked against its `sha256`, a storage receipt can only tell clients *where* to
look, never change *what* they accept.

**What gets signed:**
- **Approval signature:** the moderator signs the SHA-256 of the JCS-canonical **approval body**: the manifest with
  `approval`, `publishedAt`, `publisher` and every field **derived after approval** removed. Derived fields are `cid`,
  `variants`, `width`, `height` and `blurhash` on images and the cover, and everything on a video block except
  `source`, `title` and `description`. What remains (all text, tags, the contributor, the block order and the SHA-256
  of every original media file) is exactly what the moderator saw. The projection is implemented once, in
  `packages/schema` (`approvalBody()`), and used by every client, the API and the publisher. This is a BIP-340 Schnorr
  signature with the moderator's Nostr key.
- **Manifest hash:** the SHA-256 of the full JCS-canonical manifest, including `approval`. This is what the Nostr
  event and the chain receipt point to.
- The manifest is authenticated by the publisher-signed Nostr event (and the chain receipt), and the approval inside it
  by the moderator's signature.

Image originals are published byte-for-byte as approved, so their `sha256` is the same before and after approval.
Video originals are not published (only transcodes are), so a video block keeps the original's hash in `source`.

## 5. Moderation workflow

### 5.1 States
```
draft ──submit──► submitted ──claim──► in_review ──approve──► approved ──► publishing ──► published
                      ▲                    │  │                                                │
                      │                    │  └──reject (reason)──► rejected                   ├─unlist─► unlisted
                      └──resubmit── changes_requested ◄──request changes (notes)               └─new version─► (superseded)
```
- **Claim:** a moderator opening a submission claims it for 30 minutes (configurable) so two moderators don't review
  the same one; the claim expires automatically. Any moderator can still act on it, so a claim is advisory.
- **Approve:** the first approval moves it to `approved` and starts publishing. Later approvals are ignored.
- **Reject:** final; the reason is shown to the contributor.
- **Request changes:** notes go to the contributor, who edits and resubmits. The full history is kept.
- **Publishing failures** retry automatically. The story shows as `published` once the manifest is on IPFS and on at
  least 3 relays; Arweave and the chain receipt can finish afterwards, and their status is visible in the admin panel.
- **Video readiness:** transcoding a long video takes much longer than publishing text. A story whose videos are still
  transcoding stays in `publishing`; the admin panel shows progress. The 2-minute target (§16) applies to stories
  without video and is measured from the end of processing for stories with video.

### 5.2 Staging (before approval)
- Submissions and their media are stored **encrypted** on the staging server (envelope encryption: a random content
  key per submission, wrapped for each current moderator's **X25519** key and the owner's, using libsodium sealed
  boxes). When moderators change, re-wrap the keys.
- Media is encrypted **in chunks** (libsodium `crypto_secretstream_xchacha20poly1305`, 1 MiB chunks), so uploads can
  resume and moderators can stream a preview of a large video without downloading and decrypting all of it first.
- **The publisher can't read staging until approval.** When a moderator approves, their client unwraps the content key
  and **wraps it for the publisher's X25519 key**, and sends that with the signed approval. The publisher never holds a
  key to any submission that hasn't been approved.
- **Nothing in staging is ever written to IPFS, Arweave, relays or the chain.**
- Staging data for rejected submissions is deleted after 30 days (configurable). Approved submissions' staging copies
  are deleted after publishing completes.

### 5.3 Audit trail
Every moderation action is a signed event (moderator key) stored in the staging database and also published as a
Nostr event to our own relays: approvals, rejections, change requests, unlistings, comment hides. The owner sees the
full log, and any approval can be traced to the moderator who made it.

### 5.4 Moderator abuse and removal
- The owner can remove a moderator instantly (new signed moderator list). Their pending claims are released.
- The owner or any moderator can **unlist** a published story. This adds it to that moderator's signed unlisted list,
  and official clients stop showing it. The underlying copies can't be erased; the UI must say so honestly.
- **Limiting a compromised moderator:** the API limits unlistings per moderator (default 5 per hour, configurable) and
  alerts the owner on every unlisting. Clients ignore a moderator's unlisted list beyond a configurable size per day
  until the owner confirms. The owner can cancel any moderator's actions in bulk with an override (§3), and removing a
  moderator cancels all their list entries at once.

## 6. Publishing pipeline (runs on approval)

An idempotent worker. Each step records its result, so a retry continues where it stopped:

1. **Decrypt** the submission from staging. Re-check that the moderator is on the current list and the contributor
   isn't revoked.
2. **Process media** (§4.1).
3. **IPFS:** add all files to **at least two of our own IPFS (Kubo) nodes** in different countries and providers, and
   to **at least one paid pinning service** (decide: Filebase, Pinata or 4EVERLAND; must be configurable and
   swappable). Use CIDv1 (base32).
4. **Arweave:** upload all text, all images and video posters (decide: a bundling service such as
   ArDrive Turbo, or direct arweave-js). Full videos go to Arweave only if a configurable size and budget limit allows;
   otherwise videos rely on IPFS plus torrents. Tag uploads with `App-Name: AzaadAwaaz`, `Story-Id` and
   `Content-SHA256`.
5. **Torrent:** create a torrent for every video (MP4 and the HLS folder), with IPFS gateway URLs as web seeds, and
   seed it from our seed boxes.
6. **Manifest:** build, canonicalise, check the approval signature against the approval body, hash it and store it
   on IPFS and Arweave (§4.2).
7. **Nostr:** publish a signed (publisher key) **long-form event** (NIP-23, kind 30023, `d` tag = story id) whose
   content is the story summary, with tags pointing to the manifest (`["azaad-manifest", cid, sha256, arweaveTx]`) and
   `["t", tag]` tags. Send it to **every relay on the official relay list**: our own relays plus at least 6 public
   relays in different countries.
   - 7b. **Storage receipt:** once Arweave uploads finish, publish a publisher-signed event (kind 30078, `d` tag =
     `storage:<story id>:<version>`) mapping each `sha256` to its Arweave transaction, to the same relays.
8. **On-chain receipt:** call `publish(storyId, version, manifestSha256, manifestCid)` on the `AzaadAwaazRegistry`
   contract (§9) on **every configured EVM chain** (default: Base and BNB Smart Chain; see `docs/decisions.md`). It
   emits `Published(storyId, version, manifestSha256, manifestCid, timestamp)`. Each chain is a separate step, so one
   chain being down or censoring doesn't block the others.
9. **Mark published.** Notify the contributor in the app.

### 6.5 Corrections and updates
A published story is never edited in place. A correction is a **new version**: a new manifest with
`supersedes = previous manifest sha256`, approved through moderation like any submission. Clients show the latest
version with a "corrected on …" note and a link to the previous version. Old versions stay available.

## 7. Comments and reactions

- **Comments:** Nostr comment events (NIP-22, kind 1111) referencing the story's event. Replies to comments are
  threaded.
- **Reactions:** NIP-25 (kind 7). Supported set: 👍 ❤️ 😮 😢 😡 🙏, plus "important" (⭐).
- Readers need a key; the client creates one silently on first comment or reaction and offers a backup.
- **Moderation of comments is after the fact:** comments appear immediately. Moderators can **hide** a comment by
  signing a hide event, collected into the signed hidden-comments list, which official clients honour.
- **Spam control:**
  - Our own relays apply per-key rate limits and require NIP-13 proof-of-work (difficulty configurable, default 16)
    on comments and reactions.
  - Clients do the proof-of-work automatically.
  - Moderators can mute a key (added to the signed muted list).
- Comment text: plain text with links, ≤ 2,000 characters, no media uploads in comments.

## 8. Clients

All clients share one TypeScript core package (`packages/core`) that:
- loads the **official lists** from several sources (own relays, public relays, IPFS, Arweave, bundled defaults) and
  verifies the owner's signature;
- reads stories from relays (dedupes, honours the unlisted, hidden and muted lists, picks the latest version);
- fetches manifests and media from the **fastest working source**: race 2–3 IPFS gateways, fall back to the next ones,
  then Arweave gateways, then the torrent for videos. **Every file is verified against its hash before it's shown**; a
  mismatch means that source is skipped and flagged;
- prefers **our own gateways and the pinning services' gateways**, because public gateways are often rate-limited or
  shut down; public gateways are the last fallback. Verification is done in the client (by SHA-256 and, where
  supported, trustless CAR responses via `@helia/verified-fetch`), so no gateway has to be trusted;
- signs and publishes comments and reactions (with proof-of-work);
- handles i18n (English and Hindi).

### 8.1 Website (`apps/web`)
- **A static single-page app** (decide: Vite + React or Next.js static export) so the same build can be served from
  any domain, from IPFS (its own CID, linked from the official lists), from the onion service and from mirrors.
- **Pages:**
  - Home: latest and featured stories (featured = a signed list).
  - Story page: renders all block types, with a language switch, comments, reactions, a share button and Verify.
  - Tag pages, search, About, How to reach us when blocked, Contributor area and Moderator area.
- **Verify button:** shows the manifest hash, the IPFS CID, the Arweave transaction (from the storage receipt) and the
  on-chain receipts (each chain, transaction, block time), each checked live. A green "original and unedited" badge appears only when all checks
  pass.
- **Video player:** HLS (hls.js) with IPFS segment URLs and automatic gateway failover; WebTorrent fallback.
- **Mobile-first and fast on slow networks:** blurhash placeholders, lazy loading, works at 3G speeds.
- **No third-party scripts, fonts or analytics.** Self-host Noto Sans and Noto Sans Devanagari. Use a strict CSP.

### 8.2 Android app (`apps/android`)
- Decide: React Native (reusing `packages/core`) or Kotlin with a small core in shared TypeScript via a JS engine.
  React Native is preferred.
- **Distributed as a signed APK**: a download link on every domain, QR codes, Telegram, mirrors and IPFS. **Not on the
  Play Store.** It self-updates by checking the signed release list, verifying the APK hash and signature, then
  prompting to install.
- **Everything the website does, plus:**
  - **Built-in Tor (Arti or tor-android)** with **Snowflake and obfs4 bridges**: a "Blocked? Use Tor" switch, which
    turns on automatically when direct connections fail.
  - **Encrypted DNS (DoH)** built in, so DNS blocking doesn't affect the app.
  - **Offline sharing:** send stories phone to phone as signed, hash-verifiable bundles (manifest plus media) over
    Wi-Fi Direct, Bluetooth or a file. The receiving app verifies every hash and signature before showing anything.
  - **Save for offline:** keep stories and videos on the device.
  - **Contributor tools:** the story editor with blocks, on-device metadata stripping, upload with resume, and
    submission status.
  - **Moderator tools:** the queue, preview, approve, reject or request changes, hide comments, unlist.
- Keys live in the Android Keystore. App lock (PIN or biometric) is optional for readers and required for moderators
  and contributors.

### 8.3 Contributor and moderator web areas
In `apps/web`, behind key login (import `nsec`, or a NIP-07 browser extension), with the same features as the app,
except offline sharing.

## 9. Smart contract: `AzaadAwaazRegistry`

Deployed **identically on every configured chain** (default: Base and BNB Smart Chain). Receipts on more than one chain
remove the chain as a single point of failure.

A minimal, immutable contract (Solidity 0.8.x, Foundry, fully tested):
```solidity
event Published(bytes16 indexed storyId, uint32 version, bytes32 manifestSha256, string manifestCid, uint64 timestamp);
event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);
function publish(bytes16 storyId, uint32 version, bytes32 manifestSha256, string calldata manifestCid) external; // onlyPublisher
function setPublisher(address next) external; // onlyOwner (the owner's EVM key, kept offline)
```
- No upgradeability, no funds held, no admin delete. A receipt can never be removed or changed.
- **Version rules:** a `(storyId, version)` pair can be published only once, and versions must increase.
- Verify the source on the chain's explorer and on Sourcify.

## 10. Access: staying reachable when blocked

| Door | Setup |
|---|---|
| **azaadawaaz.org** | Main domain. Registrar outside India with WHOIS privacy (decide: Njalla, Porkbun or Namecheap). **Never a .in domain.** |
| **Spare domains** | azaadawaaz.news and azaadawaaz.net (more can be added), all on the signed mirror list; clients and the site show working alternatives |
| **Onion service** | Tor v3 onion with a vanity prefix `azaad…` (mkp224o), plus a second onion on a separate server. Use Onionbalance if load requires, and Tor's proof-of-work DoS defence. **Back up the onion keys encrypted, in 2 places.** |
| **IPFS** | The web app's own CID, reachable through any public gateway; listed in the signed lists |
| **Android app** | The strongest door: direct to relays and gateways, Tor with bridges, DoH, offline sharing |
| **Mirror kit** | `docker compose up`: a static web build plus an IPFS node pinning everything plus a Nostr relay (strfry), auto-syncing from the official lists. Mirrors appear in the signed mirror list once the owner approves them. |
| **"How to reach us" page** | On every door. Explains the alternatives in simple English and Hindi: spare domains, the onion address with a Tor Browser link, the APK download, and the Telegram channel. |

Hosting **outside India**, spread across at least 2 providers and 2 countries. Don't rely on a single CDN. If a CDN is
used, the site must also work without it.

## 11. Server-side services

| Service | Purpose |
|---|---|
| `api` | Invites, contributor and moderator auth (signed challenges), submissions, the encrypted staging store, the moderation queue, the audit log, list signing requests (the owner signs offline or in the owner app) |
| `media-worker` | Image and video processing (ffmpeg, sharp, libvips) |
| `publisher` | The publishing pipeline (§6): an idempotent job queue with retries |
| `relay` ×2+ | Our own Nostr relays (strfry), with proof-of-work and rate limits, in different countries |
| `ipfs` ×2+ | Kubo nodes that pin everything, in different countries |
| `seedbox` | Seeds video torrents |
| `web` | Serves the static web app on all domains and the onion service |
| `onion` ×2 | Tor hidden services in front of `web` (plus the moderator area) |

- **Database:** PostgreSQL for staging and moderation only (submissions, encrypted blobs metadata, the audit log,
  invites, job state). Published content is never only in our database; it can always be rebuilt from relays, IPFS and
  Arweave.
- **Rebuild test (MUST):** a script that rebuilds the full public archive (all stories, all versions) from the public
  networks alone, with an empty database. It runs **in CI on every change against local networks** (local IPFS,
  relays, ArLocal, Anvil), and **nightly against the real public networks**; a nightly failure alerts the owner. Running
  against real networks on every change would fail at random.

## 12. Security and privacy

- **No IP logging** on any of our services (web server, relays, API). No analytics, no third-party requests from
  clients.
- **Contributor safety:** on-device metadata stripping (tested with sample files carrying GPS EXIF and video location
  atoms); pen names; no personal data collected.
- **Keys:**
  - The owner key is offline.
  - The publisher key is held only by the `publisher` service, in a secrets store, and is rotatable.
  - Moderator and contributor keys stay on their devices.
- **Staging encryption** as in §5.2. Database backups are encrypted.
- **Web:** strict CSP, no inline scripts, Markdown rendered with a safe renderer (no HTML), media served with correct
  types, and every fetched file verified by its hash.
- **Threat model (document in `docs/threat-model.md`):** first and foremost **the operators themselves**: payment
  trails for domains and hosting, and legal or physical pressure on the owner and moderators, defeat any architecture.
  Then: domain seizure, DNS and IP blocking, CDN or host takedown,
  app-store removal, a relay or gateway blocking us, a compromised moderator, a compromised publisher key, DDoS,
  malicious uploads (media parsers in a sandbox), spam comments, and a legal order against an operator.

## 13. Languages

- All UI strings live in `en.json` and `hi.json`; no hard-coded text. Hindi uses Devanagari (Noto Sans Devanagari).
- The language switch is in the header. The default comes from the browser or phone language, otherwise English.
- Stories: `en`, `hi` or `both` (§4). With `both`, readers switch per story. Dates and numbers use the selected
  language's format.

## 14. Repository layout (suggested)
```
apps/web            static SPA: reader, contributor and moderator areas
apps/android        React Native app
packages/core       shared client logic: lists, relays, gateways, verification, i18n, keys
packages/schema     story manifest schema (JSON Schema + TypeScript types), canonicalisation, hashing
packages/contracts  AzaadAwaazRegistry (Foundry)
services/api        staging, moderation, invites, audit
services/publisher  publishing pipeline
services/media      media processing
infra/              docker compose for every service, mirror kit, onion setup, relay config
docs/               decisions.md, threat-model.md, runbooks (domain blocked, key rotation, moderator removal, restore)
```

## 15. Build order (one product, built in this order)
1. `packages/schema` and `packages/core`: manifest, hashing, signing, list verification, gateway and relay racing. Unit
   tests.
2. `services/api` + staging encryption + invites + the moderation state machine. Integration tests for every
   transition.
3. `services/media` and `services/publisher` against local IPFS, a local relay, an Arweave test environment (ArLocal)
   and a local chain (Anvil). One end-to-end test: a story of every block type goes from submit to approve to
   published to readable from a clean client.
4. `apps/web`: reader, Verify, comments and reactions, contributor and moderator areas, English and Hindi.
5. `apps/android`: reader, Tor and bridges, DoH, offline sharing, contributor and moderator tools, self-update.
6. `infra`: production compose, the onion services, the mirror kit, the rebuild-from-public-networks script in CI,
   and the runbooks.

## 16. Acceptance criteria (the product is done when)
- An invited contributor can submit a story with any combination of blocks, in English, Hindi or both, from the web
  and from the app.
- Uploaded media contain no GPS or device metadata (verified by tests).
- The story stays private until one moderator approves; then a story without video is readable within 2 minutes on
  all doors, and a story with video within 2 minutes after its transcoding finishes.
- Rejected and changes-requested flows work, with reasons shown to the contributor.
- The Verify button shows green for a published story, and red if any byte is altered (tested with a tampered copy).
- **Turning off any one of our servers, domains, relays or gateways leaves every published story readable** (tested
  in staging by disabling each one in turn).
- The Android app reads stories with all our domains blocked (via Tor and bridges, and via public relays and gateways)
  and can pass a story to another phone offline.
- Comments and reactions work; a hidden comment disappears from official clients; spam limits apply.
- The full archive can be rebuilt from public networks with an empty database.
- No IP addresses appear in any of our server logs.

## 17. Open questions for the owner
1. ~~Chain for receipts~~ **Decided:** Base and BNB Smart Chain, both by default; more can be added by config.
2. Monthly budget for Arweave storage of videos (decides whether full videos go to Arweave or only IPFS plus torrents).
3. Initial list of moderators and contributors.
4. Telegram channel name for announcing new doors when domains are blocked.
5. Branding: logo, colours, tagline in English and Hindi.

## 18. Glossary
- **CID:** an IPFS content identifier; the link is derived from the file's contents.
- **Pinning:** keeping a file stored on an IPFS node so it stays available.
- **Arweave:** a network that stores files permanently for a one-time payment.
- **Nostr:** an open protocol for signed messages sent to many independent relays.
- **Relay:** a server that stores and forwards Nostr events; anyone can run one.
- **Onion service:** a website reachable only through Tor, with an address derived from its key.
- **Bridge (Snowflake/obfs4):** a way to reach Tor when Tor itself is blocked.
- **Manifest:** the JSON document that describes a published story and the hashes of all its files.
