import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "server",
    // fixture(256 MiB に展開される bomb を含む)の生成・解析に少し時間がかかる
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
