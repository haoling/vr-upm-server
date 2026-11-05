import { serveStatic } from "@hono/node-server/serve-static";
import type { HealthResponse } from "@vr-upm/shared";
import { Hono } from "hono";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { buildRoutes, publishedRoutes } from "./builds/routes.js";
import { originCheck } from "./middleware/origin-check.js";
import { packageRoutes } from "./packages/routes.js";
import { uploadRoutes } from "./uploads/routes.js";
import { VERSION } from "./version.js";

export interface AppDeps {
  config: Pick<Config, "MODE" | "ALLOWED_ORIGINS" | "WEB_DIST_DIR" | "WORKSPACE_DIR" | "MAX_UPLOAD_BYTES" | "REGISTRY_URL" | "REGISTRY_TOKEN">;
  db: Db;
}

/**
 * 管理画面 API。
 * 認証・認可は持たない(DESIGN.md 8.3: OIDC 認証プロキシに任せる)。
 */
export function createApp({ config, db }: AppDeps) {
  // URL とトークンが揃っているときだけ publish できる
  const registry = config.REGISTRY_URL && config.REGISTRY_TOKEN ? { url: config.REGISTRY_URL, token: config.REGISTRY_TOKEN } : null;
  const api = new Hono()
    .use(originCheck(config.ALLOWED_ORIGINS))
    .get("/health", (c) =>
      c.json({ status: "ok", version: VERSION, mode: config.MODE } satisfies HealthResponse),
    )
    .route("/uploads", uploadRoutes({ db, workspaceDir: config.WORKSPACE_DIR, maxUploadBytes: config.MAX_UPLOAD_BYTES }))
    .route("/packages", packageRoutes({ db }))
    .route("/builds", buildRoutes({ db, workspaceDir: config.WORKSPACE_DIR, registry }))
    .route("/", publishedRoutes({ db, registry, registryUrl: config.REGISTRY_URL ?? null }));

  const app = new Hono().route("/api", api);

  if (config.WEB_DIST_DIR) {
    const root = config.WEB_DIST_DIR;
    app.use("/*", serveStatic({ root }));
    // SPA のクライアントルーティング用フォールバック
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  return app;
}
