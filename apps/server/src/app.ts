import { serveStatic } from "@hono/node-server/serve-static";
import type { HealthResponse, UploadListResponse } from "@vr-upm/shared";
import { desc } from "drizzle-orm";
import { Hono } from "hono";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { uploads } from "./db/schema.js";
import { originCheck } from "./middleware/origin-check.js";
import { VERSION } from "./version.js";

export interface AppDeps {
  config: Pick<Config, "MODE" | "ALLOWED_ORIGINS" | "WEB_DIST_DIR">;
  db: Db;
}

/**
 * 管理画面 API。
 * 認証・認可は持たない(DESIGN.md 8.3: OIDC 認証プロキシに任せる)。
 */
export function createApp({ config, db }: AppDeps) {
  const api = new Hono()
    .use(originCheck(config.ALLOWED_ORIGINS))
    .get("/health", (c) =>
      c.json({ status: "ok", version: VERSION, mode: config.MODE } satisfies HealthResponse),
    )
    .get("/uploads", (c) => {
      const rows = db.select().from(uploads).orderBy(desc(uploads.id)).all();
      const body: UploadListResponse = {
        uploads: rows.map((r) => ({
          id: r.id,
          sha256: r.sha256,
          originalFilename: r.originalFilename,
          size: r.size,
          uploadedAt: r.uploadedAt,
          fileState: r.fileState,
        })),
      };
      return c.json(body);
    });

  const app = new Hono().route("/api", api);

  if (config.WEB_DIST_DIR) {
    const root = config.WEB_DIST_DIR;
    app.use("/*", serveStatic({ root }));
    // SPA のクライアントルーティング用フォールバック
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  return app;
}
