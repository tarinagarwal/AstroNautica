// Build-time stand-in for the `nostr-tools` package index, which bundles every NIP (and its ciphers) into one file.
// Core only takes `nip19` from it; everything else is imported from the per-NIP entry points (see vite.config.ts).
export * as nip19 from "nostr-tools/nip19";
