# AzaadAwaaz — notes for Claude Code

A censorship-resistant, bilingual (English/Hindi) news platform. **Read `docs/SPEC.md` (what), `docs/architecture.md`
(internal contracts: DB schema, API, staging layout, pipeline steps) and `docs/decisions.md` (why) before changing
anything.** Live progress is in `docs/STATUS.md` — update it after every phase.

## Layout
pnpm monorepo (Node 22, TypeScript strict ESM, Vitest). `packages/*` (schema, core, media-strip, contracts),
`services/*` (api, media, publisher), `apps/*` (web, android), `infra/*` (dev, prod, mirror, relay), `scripts/`.

## Commands
- `pnpm install`; build libraries before dependents: `pnpm -r build`
- `pnpm lint` (ESLint flat config at root), `pnpm format:check` (Prettier, width 120), `pnpm typecheck`, `pnpm test`
- Contracts: `cd packages/contracts && FOUNDRY_SOLC=$PWD/scripts/solcjs FOUNDRY_OFFLINE=true forge test`
  (binaries.soliditylang.org is blocked here; the wrapper uses npm `solc@0.8.28`)
- Dev network: `infra/dev` docker compose (2 strfry relays 7777/7778, 2 Kubo 5001/5002 + gateways 8080/8081,
  Postgres 5432, ArLocal 1984, anvil 8545 (31337) and 8546 (97)). Start Docker first if needed: `dockerd &`.
- Relay integration test: `TEST_RELAYS=ws://127.0.0.1:7777 pnpm --filter @azaadawaaz/core test`

## Conventions and gotchas
- Never use nostr-tools `verifyEvent` on events you didn't just parse from JSON: it caches a "verified" symbol that
  survives `{...e}` copies. Use `verifyEventStrict` from core.
- Node code must pass `ws` to `RelayPool` (Node's built-in WebSocket overflows the stack in nostr-tools on dead relays).
- Approval signatures cover `approvalMessageHash(approvalBodySha256(story), approvedAt)` — never hash a manifest
  ad hoc; use `packages/schema`.
- No IP logging anywhere. No third-party requests from clients. No raw HTML in Markdown.
- Media is stripped on the device (`packages/media-strip`) and re-checked on the server.
- Owner key is offline; daily moderation uses moderator-signed lists (decision D5).
- Commit only to branch `ccr-2fc6e99f-vk51vj`.

## End-to-end test
`docker compose -f infra/dev/docker-compose.yml up -d --wait && node scripts/dev-setup.mjs && pnpm -r build && node scripts/e2e.mjs`
— starts the API and publisher itself and runs 62 checks across every acceptance criterion it can cover locally.
API tests use the dev Postgres database `azaadawaaz_test` (override with `TEST_DATABASE_URL`).
