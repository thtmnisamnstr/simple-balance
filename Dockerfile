FROM node:24-alpine AS pnpm
RUN npm install --global pnpm@11.9.0

FROM pnpm AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
RUN pnpm build

FROM pnpm AS runtime-dependencies
WORKDIR /runtime
COPY runtime/package.json runtime/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-workspace \
  --config.auto-install-peers=false

FROM node:24-alpine AS runtime
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
LABEL org.opencontainers.image.title="Simple Balance" \
  org.opencontainers.image.description="Self-hosted personal accounting with safe, reviewable AI automation" \
  org.opencontainers.image.version="0.1.0"
COPY --from=runtime-dependencies --chown=node:node /runtime/package.json ./package.json
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/server/index.js"]
