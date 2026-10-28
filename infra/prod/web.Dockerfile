# The `web` image: the static apps/web build served by nginx with
# infra/prod/nginx.conf (strict CSP, no access log, no IP logging).
#
# Build context is the repository root (pnpm workspace):
#   docker build -f infra/prod/web.Dockerfile -t azaadawaaz/web .

FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# apps/web and the workspace packages it depends on.
RUN pnpm --filter "./apps/web..." build
# Vite's default output directory.
ARG WEB_DIST=apps/web/dist
RUN test -f "$WEB_DIST/index.html" && cp -r "$WEB_DIST" /out

FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /run/onion /var/www/acme
COPY infra/prod/nginx.conf /etc/nginx/nginx.conf
COPY infra/prod/azaad-headers.conf /etc/nginx/azaad-headers.conf
COPY infra/prod/azaad-app.conf /etc/nginx/azaad-app.conf
COPY --from=build /out /usr/share/nginx/html
EXPOSE 80 443
