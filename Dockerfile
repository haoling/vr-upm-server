# syntax=docker/dockerfile:1
# API・Worker・ビルド済み SPA を 1 イメージにまとめる(DESIGN.md 5章)

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
# better-sqlite3 のビルドにプリビルドが無い場合に備える
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @vr-upm/server --filter @vr-upm/web build
# server の本番依存だけを /out に取り出す
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @vr-upm/server deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MODE=all \
    PORT=3000 \
    DB_PATH=/data/db/app.sqlite \
    WORKSPACE_DIR=/data/workspace \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
