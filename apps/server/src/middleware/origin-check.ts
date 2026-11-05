import type { ApiError } from "@vr-upm/shared";
import { createMiddleware } from "hono/factory";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 許可する Origin の判定を作る。
 * - `https://upm.example.com` のような完全一致
 * - `https://*.coder.example.com` のようなサブドメインのワイルドカード(scheme とポートは一致が必要。
 *   `*` は 1 つ以上のラベルに一致し、`coder.example.com` 自身や `evilcoder.example.com` には一致しない)
 */
export function createOriginMatcher(allowedOrigins: readonly string[]): (origin: string) => boolean {
  const exact = new Set<string>();
  const wildcards: Array<{ protocol: string; suffix: string; port: string }> = [];
  for (const entry of allowedOrigins) {
    if (!entry.includes("*")) {
      exact.add(entry);
      continue;
    }
    // `scheme://*.suffix[:port]` の形だけを受け付ける。`*.` を実在するホスト名に置き換えて URL として読む
    if (!/^[a-z][a-z0-9+.-]*:\/\/\*\./i.test(entry) || entry.indexOf("*") !== entry.lastIndexOf("*")) continue;
    try {
      const url = new URL(entry.replace("*.", "wildcard."));
      wildcards.push({ protocol: url.protocol, suffix: url.hostname.slice("wildcard".length), port: url.port });
    } catch {
      // 読めない設定は無視する(何も許可しない側に倒す)
    }
  }
  return (origin) => {
    if (exact.has(origin)) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    return wildcards.some(
      (w) => url.protocol === w.protocol && url.port === w.port && url.hostname.endsWith(w.suffix) && url.hostname.length > w.suffix.length,
    );
  };
}

/**
 * 状態を変えるリクエストの Origin を確認する最低限の CSRF 対策(DESIGN.md 8.3)。
 * 認証ではなく、認証プロキシの Cookie を悪用した外部サイトからのリクエストを防ぐためのもの。
 *
 * Origin ヘッダが無いリクエスト(curl やクラスタ内からの呼び出し)は通す。
 */
export function originCheck(allowedOrigins: readonly string[]) {
  const isAllowed = createOriginMatcher(allowedOrigins);
  return createMiddleware(async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isAllowed(origin)) {
        return c.json({ error: "origin not allowed", code: "origin-not-allowed" } satisfies ApiError, 403);
      }
    }
    await next();
  });
}
