# The API on its own, for a deployment that has split the single container into
# pieces. Build from the repository root:
#
#   docker build -f deploy/docker/server.Dockerfile -t simple-balance-server .
#
# It carries no client bundle. A request for a page falls through to a 404
# rather than being answered with an application shell this image is not the
# authority on; the frontend image serves those and proxies the rest here.
#
# Pinned by digest as well as by tag. A tag moves, so `node:24-alpine` on its own
# is not a build anybody can reproduce, and the digest is what the `base.digest`
# label below claims: bump one without the other and `tests/dockerfile.test.ts`
# says so rather than shipping an image that lies about what it is built on.
# `.github/dependabot.yml` watches Docker so the pin is raised deliberately
# instead of freezing, and `apk upgrade` in the runtime stage still takes
# whatever Alpine has published since. The digest is the multi-platform index's
# rather than one architecture's manifest, so an arm64 build still resolves its
# own image.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.server.json ./
COPY src ./src
RUN npm run build:server

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime-dependencies
WORKDIR /runtime
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ARG APP_VERSION=0.1.5
# `created` and `revision` are deliberately absent. A Dockerfile cannot emit a
# label conditionally, so a defaulted ARG would give every hand-built image
# `org.opencontainers.image.revision=""`, which reads to a consumer as known and
# empty rather than as absent. They belong to the builder that knows them, which
# is the release workflow.
LABEL org.opencontainers.image.title="Simple Balance API" \
  org.opencontainers.image.description="Simple Balance API and MCP server, without the browser bundle" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.licenses="AGPL-3.0-only" \
  org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance" \
  org.opencontainers.image.url="https://github.com/thtmnisamnstr/simple-balance" \
  org.opencontainers.image.documentation="https://github.com/thtmnisamnstr/simple-balance#readme" \
  org.opencontainers.image.base.name="node:24-alpine" \
  org.opencontainers.image.base.digest="sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43"
COPY --from=runtime-dependencies --chown=node:node /runtime/package.json ./package.json
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --chown=node:node drizzle ./drizzle
# This image conveys an AGPL-3.0 program, so it carries the terms it is offered
# under. The AGPL is a complete licence rather than a supplement, so one file
# is enough, and the source label above says where the corresponding source is.
COPY --chown=node:node LICENSE ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/server/index.js"]
