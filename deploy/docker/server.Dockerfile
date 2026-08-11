# The API on its own, for a deployment that has split the single container into
# pieces. Build from the repository root:
#
#   docker build -f deploy/docker/server.Dockerfile -t simple-balance-server .
#
# It carries no client bundle. A request for a page falls through to a 404
# rather than being answered with an application shell this image is not the
# authority on; the frontend image serves those and proxies the rest here.
FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build:server

FROM node:24-alpine AS runtime-dependencies
WORKDIR /runtime
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ARG APP_VERSION=0.1.3
LABEL org.opencontainers.image.title="Simple Balance API" \
  org.opencontainers.image.description="Simple Balance API and MCP server, without the browser bundle" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.licenses="LGPL-3.0-only" \
  org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance"
COPY --from=runtime-dependencies --chown=node:node /runtime/package.json ./package.json
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --chown=node:node drizzle ./drizzle
# This image conveys an LGPL-3.0 program, so it carries the terms it is offered
# under. COPYING is the GPL text the LGPL is written as an extension of.
COPY --chown=node:node LICENSE COPYING ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/server/index.js"]
