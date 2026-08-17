# Node 24 is the current LTS (supported to April 2028); 22 drops out of
# maintenance in April 2027.
#
# SQLite is built into Node from 24.19, so this carries no native module —
# nothing to compile, and no toolchain in any stage.
FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

# pnpm-workspace.yaml carries the overrides and build policy from pnpm 11 on;
# without it the lockfile's recorded config does not match and a frozen
# install refuses to proceed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build


FROM node:24-alpine AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod


# Bare Alpine plus the node binary, rather than the official node image.
# That image also carries npm and corepack (~19MB) which nothing runs in
# production, and deleting them in a later layer would not shrink anything —
# they would still sit in the parent layer.
FROM alpine:3.21

LABEL org.opencontainers.image.title="share-historys" \
      org.opencontainers.image.description="Reposts Telegram stories to Instagram" \
      org.opencontainers.image.source="https://github.com/Pepebits/share-historys" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache libstdc++ \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=node:24-alpine /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
ENV NODE_ENV=production

# --chown here rather than a later RUN chown: that would copy every file into
# a second layer, doubling the weight of node_modules.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Holds the Telegram session, the rotating Instagram token and the dedupe
# database. Mount it: losing it means re-authenticating by hand.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node

# Reachable by whatever fronts this with TLS. Never publish it straight to the
# internet: it serves story media at unauthenticated URLs.
EXPOSE 8080

# Liveness only — it reports nothing about what is hosted.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:${MEDIA_SERVER_PORT:-8080}/health" || exit 1

CMD ["node", "dist/index.js"]
