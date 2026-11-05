// 本番用に src/main.ts を 1 ファイルへバンドルする。
// ワークスペース内パッケージ(@vr-upm/*)は TS ソースのまま参照しているので取り込み、
// それ以外の npm 依存(better-sqlite3 などネイティブモジュールを含む)は外部扱いにする。
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith("@vr-upm/"));

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  logLevel: "info",
});
