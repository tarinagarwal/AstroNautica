# apps/web

Static single-page app (Vite + React 18 + TypeScript, `HashRouter`): reader, Verify, comments and reactions,
contributor and moderator areas, English and Hindi. Same build works on any domain, an IPFS path gateway, the onion
service and mirrors (`base: "./"`, hash routes).

## Commands

| What | Command |
|---|---|
| Bundled defaults (owner key + signed lists) | `pnpm --filter @azaadawaaz/web gen-defaults` (runs automatically before dev/build/test) |
| Dev server | `pnpm --filter @azaadawaaz/web dev` |
| Production build | `pnpm --filter @azaadawaaz/web build` → `dist/` |
| Build for the local dev network (CSP allows loopback) | `pnpm --filter @azaadawaaz/web build:localnet` |
| Unit/component tests (Vitest + jsdom) | `pnpm --filter @azaadawaaz/web test` |
| End-to-end (Playwright, real strfry relay in Docker) | `pnpm --filter @azaadawaaz/web e2e` |

Build `packages/schema`, `packages/core`, `packages/contracts` and `packages/media-strip` first.

`scripts/gen-defaults.mjs` writes `src/defaults.json` (gitignored) from `DEFAULTS_CONFIG` / `DEFAULTS_LIST_EVENTS`
or, in dev, `.dev/config.json` and `.dev/list-events.json`. Without them the app still runs and shows "No official
lists found".

The e2e suite uses ports 7791 (relay container `web-test-relay`), 7792 (IPFS/Arweave gateway + chain RPC mock), 7793
(API mock) and 4791 (`vite preview`), and writes screenshots to `test-results/` (gitignored).

## Content-Security-Policy

The build puts this policy in a `<meta>` tag (so it holds on mirrors and gateways that send no header). Serve the same
policy as a header, plus `frame-ancestors 'none'` (header-only):

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:;
media-src 'self' blob:; font-src 'self'; connect-src 'self' https: wss:; worker-src 'self';
manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

- **No inline scripts or styles** (React sets styles through the CSSOM, which CSP permits); no `eval`.
- **`'wasm-unsafe-eval'`** lets libsodium (staging encryption, contributor and moderator areas only) compile its
  WebAssembly. It does not permit JavaScript `eval`. Without it libsodium still works through its pure-JS fallback
  (checked in a browser), only slower and with a CSP console error; `infra/prod/nginx.conf` currently omits it.
- **`connect-src https: wss:`**: relays, gateways, chain RPCs and the API come from signed lists at run time, so they
  can't be enumerated at build time; every byte fetched is verified by hash. The onion build should add
  `http://*.onion ws://*.onion`. `vite build --mode localnet` adds `http://127.0.0.1:* ws://127.0.0.1:*` (and
  `localhost`) for the local dev network only.
- **`img-src`/`media-src` `blob:`**: images and video are shown from object URLs created after hash verification;
  the browser never fetches media from a gateway directly. HLS segments go through a custom hls.js loader that
  verifies each IPFS block against its CID.

## Notes

- Image variants are chosen in JavaScript (not `srcset`): a browser fetching `srcset` candidates itself would display
  unverified bytes.
- WebTorrent is not included: it needs WebRTC peers and trackers outside this CSP; videos fall back from HLS to the
  SHA-256-verified MP4 instead.
