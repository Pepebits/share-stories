# Alpine keeps the runtime ~120MB smaller than -slim. The cost is that
# better-sqlite3 has no musl prebuild and must be compiled, so the toolchain
# lives in a build stage and never reaches the final image.
FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

# Copied first so the dependency layer survives source-only changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build


FROM node:22-alpine AS deps

WORKDIR /app
RUN corepack enable && apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml ./
# Production only. The native binding is compiled here against the same base
# image the runtime uses, so the ABI and libc match.
RUN pnpm install --frozen-lockfile --prod


FROM node:22-alpine

LABEL org.opencontainers.image.title="share-historys" \
      org.opencontainers.image.description="Reposts Telegram stories to Instagram" \
      org.opencontainers.image.source="https://github.com/Pepebits/share-historys" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Holds the Telegram session, the rotating Instagram token and the dedupe
# database. Mount it: losing it means re-authenticating by hand.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

# Reachable by whatever fronts this with TLS. Never publish it straight to the
# internet: it serves story media at unauthenticated URLs.
EXPOSE 8080

# Liveness only — it reports nothing about what is hosted.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:${MEDIA_SERVER_PORT:-8080}/health" || exit 1

CMD ["node", "dist/index.js"]
