FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime-dependencies
WORKDIR /runtime
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# The release workflow passes the tag being published so the image reports the
# version it actually contains.
ARG APP_VERSION=0.1.5
# `created` and `revision` are deliberately absent. A Dockerfile cannot emit a
# label conditionally, so a defaulted ARG would give every hand-built image
# `org.opencontainers.image.revision=""`, which reads to a consumer as known and
# empty rather than as absent. They belong to the builder that knows them, which
# is the release workflow.
LABEL org.opencontainers.image.title="Simple Balance" \
  org.opencontainers.image.description="Self-hosted personal accounting: every account in one place, statements that import themselves, and reports that add up" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.licenses="AGPL-3.0-only" \
  org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance" \
  org.opencontainers.image.url="https://github.com/thtmnisamnstr/simple-balance" \
  org.opencontainers.image.documentation="https://github.com/thtmnisamnstr/simple-balance#readme" \
  org.opencontainers.image.base.name="node:24-alpine"
COPY --from=runtime-dependencies --chown=node:node /runtime/package.json ./package.json
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
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
