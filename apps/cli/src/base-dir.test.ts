import { describe, expect, it } from "vitest";
import { baseDir } from "./base-dir.js";

describe("baseDir", () => {
  it("Yarn 経由(PROJECT_CWD あり)ではリポジトリのルートを基準にする", () => {
    expect(baseDir({ PROJECT_CWD: "/repo", INIT_CWD: "/repo/apps/cli" }, "/repo/apps/cli")).toBe("/repo");
  });

  it("直接実行では cwd を使う(INIT_CWD は見ない)", () => {
    expect(baseDir({ INIT_CWD: "/somewhere" }, "/work")).toBe("/work");
    expect(baseDir({ PROJECT_CWD: "" }, "/work")).toBe("/work");
  });
});
