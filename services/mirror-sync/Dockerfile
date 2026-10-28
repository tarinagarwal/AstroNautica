# Built with the repository root as context (see infra/mirror/docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/schema packages/schema
COPY packages/core packages/core
COPY scripts scripts
COPY services/mirror-sync services/mirror-sync
RUN pnpm install --frozen-lockfile --filter "@azaadawaaz/mirror-sync..." \
 && pnpm --filter @azaadawaaz/schema build && pnpm --filter @azaadawaaz/core build \
 && pnpm --filter @azaadawaaz/mirror-sync deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out /app
USER node
CMD ["node", "src/main.mjs"]
