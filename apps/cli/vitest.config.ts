import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cli",
    // fixture(256 MiB に展開される bomb を含む)の生成に少し時間がかかる
    hookTimeout: 60_000,
  },
});
