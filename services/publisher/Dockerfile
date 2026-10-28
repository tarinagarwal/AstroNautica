# Built with the repository root as context (infra/prod/docker-compose.yml).
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY services/media services/media
COPY services/publisher services/publisher
RUN pnpm install --frozen-lockfile --filter "@azaadawaaz/publisher..." \
 && pnpm --filter "@azaadawaaz/publisher^..." --filter "!@azaadawaaz/contracts" build \
 && pnpm --filter @azaadawaaz/contracts build \
 && pnpm --filter @azaadawaaz/publisher build \
 && pnpm --filter @azaadawaaz/publisher deploy --prod --legacy /out

FROM node:22-bookworm-slim
# No ffmpeg here on purpose: in production media is processed by the isolated media container (MEDIA_URL).
WORKDIR /app
COPY --from=build /out /app
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
