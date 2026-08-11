# The recurrence scheduler on its own. Build from the repository root:
#
#   docker build -f deploy/docker/scheduler.Dockerfile -t simple-balance-scheduler .
#
# Run exactly one replica and set RECURRENCE_SCHEDULER=false on the API
# Deployment. Running more than one is safe rather than correct-by-accident: an
# advisory lock lets a single replica tick at a time and the losers return
# immediately, so extra replicas cost nothing and buy nothing.
FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.server.json ./
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
ARG APP_VERSION=0.1.4
LABEL org.opencontainers.image.title="Simple Balance scheduler" \
  org.opencontainers.image.description="Proposes recurring transactions into the review queue" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.licenses="LGPL-3.0-only" \
  org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance"
COPY --from=runtime-dependencies --chown=node:node /runtime/package.json ./package.json
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node LICENSE COPYING ./
USER node
# Health checks only. Nothing else is mounted on this port, so a Service
# pointed here by mistake cannot serve an API request.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/server/scheduler.js"]
