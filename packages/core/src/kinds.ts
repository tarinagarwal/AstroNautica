/** Nostr event kinds and tag conventions used by AzaadAwaaz. */

/** NIP-23 long-form article; `d` tag = story id. */
export const KIND_STORY = 30023;
/** NIP-78 application data (parameterized replaceable); used for signed lists and storage receipts. */
export const KIND_APP_DATA = 30078;
/** NIP-22 comment. */
export const KIND_COMMENT = 1111;
/** NIP-25 reaction. */
export const KIND_REACTION = 7;
/** Moderation audit events (approve, reject, request changes, unlist, hide). Regular, so relays keep every one. */
export const KIND_AUDIT = 9737;

export const LIST_D_PREFIX = "azaad:list:";
export const STORAGE_D_PREFIX = "azaad:storage:";

/** Lists signed by the owner key (rarely change). */
export const OWNER_LISTS = [
  "moderators",
  "service-keys",
  "relays",
  "gateways",
  "mirrors",
  "onions",
  "releases",
  "overrides",
  "vouched",
] as const;

/** Lists signed by each moderator (and the owner); clients take the union across current moderators. */
export const MODERATOR_LISTS = [
  "contributors",
  "revoked-contributors",
  "unlisted",
  "hidden",
  "muted",
  "featured",
] as const;

export type OwnerListName = (typeof OWNER_LISTS)[number];
export type ModeratorListName = (typeof MODERATOR_LISTS)[number];
export type ListName = OwnerListName | ModeratorListName;

export const listD = (name: ListName) => LIST_D_PREFIX + name;
export const storageD = (storyId: string, version: number) => `${STORAGE_D_PREFIX}${storyId}:${version}`;

export const TAG_MANIFEST = "azaad-manifest";
export const TAG_VERSION = "azaad-version";
