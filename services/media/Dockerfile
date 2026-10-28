# syntax=docker/dockerfile:1
# Media processing (services/media): the @azaadawaaz/media library and the azaad-media CLI, with ffmpeg.
# Build context is the repository root (infra/prod/docker-compose.yml: context ../.., dockerfile
# services/media/Dockerfile), because the service depends on the workspace package packages/media-strip.
#
#   docker build -f services/media/Dockerfile -t azaadawaaz/media .
#   docker run --rm -v "$PWD:/work" azaadawaaz/media video /work/in.mp4 /work/out

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/media-strip/package.json packages/media-strip/
COPY services/media/package.json services/media/
RUN pnpm install --frozen-lockfile --filter "@azaadawaaz/media..." --filter azaadawaaz
COPY packages/media-strip/tsconfig.json packages/media-strip/
COPY packages/media-strip/src packages/media-strip/src
COPY services/media/tsconfig.json services/media/
COPY services/media/src services/media/src
RUN pnpm --filter "@azaadawaaz/media..." build \
 && pnpm --filter @azaadawaaz/media deploy --prod --legacy /out

FROM node:22-bookworm-slim
# ffmpeg/ffprobe for video; util-linux provides prlimit, used to put kernel resource limits on them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg util-linux \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
ENV NODE_ENV=production
# Unprivileged; the compose file adds a read-only root, a tmpfs /tmp, no capabilities and memory/pid limits.
USER node
# Default: the media worker (POST /process). For the CLI: docker compose run --rm media node /app/dist/cli.js image <in> <out>
CMD ["node", "/app/dist/server.js"]
