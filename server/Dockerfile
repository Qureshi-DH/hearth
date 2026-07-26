# syntax=docker/dockerfile:1.7
#
# Build context is the repository root:
#   docker build -f server/Dockerfile -t hearth-api .
#
# The build is split so the runtime image stays small: the final image carries
# only the bundled server, its production node_modules, and the SQL migrations.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
# The mobile app is a workspace member, and its manifest has to exist for pnpm
# to resolve the lockfile, but nothing from it is installed here. The root
# postinstall applies the app's patches and needs its script and the patch
# files to run at all; it finds no patched package here and does nothing.
COPY apps/mobile/package.json apps/mobile/
COPY scripts scripts
COPY patches patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @hearth/server... --filter @hearth/shared...

# ---------------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY server server
RUN pnpm --filter @hearth/server build

# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY apps/mobile/package.json apps/mobile/
COPY scripts scripts
COPY patches patches
# The repo's .npmrc hoists for Metro's benefit, but a hoisted install ignores
# --filter and drags the entire mobile toolchain into the image (~700 MB).
# The isolated linker respects the filter. The lockfile is linker-agnostic.
RUN echo "node-linker=isolated" > .npmrc
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @hearth/server...

# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

RUN addgroup -S hearth && adduser -S hearth -G hearth \
 && apk add --no-cache curl tini

COPY --from=prod-deps --chown=hearth:hearth /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=hearth:hearth /repo/server/node_modules ./server/node_modules
COPY --from=build     --chown=hearth:hearth /repo/server/dist ./server/dist
COPY --from=build     --chown=hearth:hearth /repo/server/src/db/migrations ./server/dist/db/migrations
COPY --from=build     --chown=hearth:hearth /repo/server/package.json ./server/package.json

USER hearth
WORKDIR /app/server
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/readyz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
