import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 開発時は API を apps/server に転送する
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
