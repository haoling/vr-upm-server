import { createMiddleware } from "hono/factory";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 状態を変えるリクエストの Origin を確認する最低限の CSRF 対策(DESIGN.md 8.3)。
 * 認証ではなく、認証プロキシの Cookie を悪用した外部サイトからのリクエストを防ぐためのもの。
 *
 * Origin ヘッダが無いリクエスト(curl やクラスタ内からの呼び出し)は通す。
 */
export function originCheck(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return createMiddleware(async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !allowed.has(origin)) {
        return c.json({ error: "origin not allowed" }, 403);
      }
    }
    await next();
  });
}
