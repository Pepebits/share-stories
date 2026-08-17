# better-sqlite3 ships prebuilt binaries for glibc but not reliably for musl,
# so this uses -slim rather than -alpine to avoid compiling it from source.
FROM node:22-slim AS build

WORKDIR /app
RUN corepack enable

# Copied first so the dependency layer survives source-only changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build


FROM node:22-slim AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
# Production only: the native better-sqlite3 binding is built here against the
# same base image the runtime uses, so the ABI matches.
RUN pnpm install --frozen-lockfile --prod


FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The session string and the Instagram token live here, so it must be a
# volume: losing it means re-authenticating by hand.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

# Reachable from the tunnel container; never publish this port to the host or
# to the internet directly — it serves story media at unauthenticated URLs.
EXPOSE 8080

CMD ["node", "dist/index.js"]
