import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // 開発サーバーに別のホスト名(リバースプロキシ・クラウド開発環境など)から入るときは、
  // `ALLOWED_HOSTS=host1,host2` を環境変数か apps/web/.env に書く。`true` なら全ホストを許可する
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const hosts = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedHosts = hosts.length === 1 && hosts[0] === "true" ? true : hosts;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      allowedHosts,
      // 開発時は API を apps/server に転送する
      proxy: {
        "/api": "http://localhost:3000",
      },
    },
  };
});
