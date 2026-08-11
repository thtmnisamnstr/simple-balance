# The browser bundle, served by nginx, with everything the API owns proxied
# through to the server container. Build from the repository root:
#
#   docker build -f deploy/docker/frontend.Dockerfile -t simple-balance-frontend .
#
# Point SB_API_ORIGIN at the API Service. Cookies are set by the API and read by
# the browser, so both have to be reached on one origin: this container is that
# origin, and APP_BASE_URL on the server has to name it.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build:client

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
ARG APP_VERSION=0.1.4
LABEL org.opencontainers.image.title="Simple Balance frontend" \
  org.opencontainers.image.description="Simple Balance browser bundle, served by nginx" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.licenses="LGPL-3.0-only" \
  org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance"
# 8080 rather than 80: the unprivileged image runs as a non-root user, which
# cannot bind a privileged port.
ENV SB_FRONTEND_PORT=8080
ENV SB_API_ORIGIN=http://simple-balance-server:3000
ENV SB_MAX_UPLOAD_SIZE=12m
# Only SB_ names are substituted, so nginx's own $host and $remote_addr are not
# blanked out by an envsubst pass that does not know the difference.
ENV NGINX_ENVSUBST_FILTER=^SB_
# The rendered result replaces the image's own default server rather than
# sitting beside it. Two servers listening on one port with server_name _ is a
# conflict nginx resolves by picking whichever the include glob reached first.
COPY deploy/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/client /usr/share/nginx/html
COPY LICENSE COPYING /usr/share/licenses/simple-balance/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/bin/sh", "-c", "wget -q -O /dev/null http://127.0.0.1:${SB_FRONTEND_PORT}/ || exit 1"]
