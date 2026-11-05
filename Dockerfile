# syntax=docker/dockerfile:1
# API・Worker・ビルド済み SPA を 1 イメージにまとめる(DESIGN.md 5章)

FROM node:22-bookworm-slim AS base
# packageManager に書いた Yarn のバージョンを corepack が入れる
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 YARN_CACHE_FOLDER=/yarn-cache
RUN corepack enable
WORKDIR /repo

FROM base AS build
# better-sqlite3 のビルドにプリビルドが無い場合に備える
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,id=yarn,target=/yarn-cache yarn install --immutable
RUN yarn workspace @vr-upm/server build && yarn workspace @vr-upm/web build
# node_modules を server の本番依存だけに入れ直す。
# @vr-upm/* はバンドル済みなので、ワークスペースへのシンボリックリンクは消しておく
RUN --mount=type=cache,id=yarn,target=/yarn-cache yarn workspaces focus @vr-upm/server --production \
 && rm -rf node_modules/@vr-upm

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MODE=all \
    PORT=3000 \
    DB_PATH=/data/db/app.sqlite \
    WORKSPACE_DIR=/data/workspace \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/server/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
