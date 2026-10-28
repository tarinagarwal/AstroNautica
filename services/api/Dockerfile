# services/api image. Build context: the repository root (pnpm workspace), as in infra/prod/docker-compose.yml:
#   docker build -f services/api/Dockerfile -t azaadawaaz/api .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@azaadawaaz/api..."
COPY packages/schema packages/schema
COPY packages/core packages/core
COPY services/api services/api
RUN pnpm --filter "@azaadawaaz/api..." build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@azaadawaaz/api..."

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /repo
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/packages/schema/node_modules ./packages/schema/node_modules
COPY --from=prod-deps /repo/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /repo/services/api/node_modules ./services/api/node_modules
COPY --from=build /repo/packages/schema/package.json ./packages/schema/
COPY --from=build /repo/packages/schema/dist ./packages/schema/dist
COPY --from=build /repo/packages/core/package.json ./packages/core/
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/services/api/package.json ./services/api/
COPY --from=build /repo/services/api/dist ./services/api/dist
COPY --from=build /repo/services/api/migrations ./services/api/migrations
# Staging volume mount point, owned by the unprivileged user; the code itself stays root-owned and read-only.
RUN mkdir -p /var/lib/azaadawaaz/staging && chown node:node /var/lib/azaadawaaz/staging
USER node
WORKDIR /repo/services/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
