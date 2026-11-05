// Docker が無い環境で publish を試すための、ローカル用 Verdaccio(`yarn dev:registry`)。
// 設定は docker compose と同じ verdaccio/conf/config.yaml。ユーザーは開発用の固定パスワードで作る。
// データは ./data/verdaccio に置く(消せば空に戻る)。本番・共有環境では使わないこと。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loginForToken, startVerdaccio } from "./test-support/verdaccio.js";

const port = Number(process.env.REGISTRY_PORT ?? 4873);
const dir = resolve(process.env.REGISTRY_DATA_DIR ?? "./data/verdaccio");
mkdirSync(dir, { recursive: true });

const publisher = { name: "publisher", password: "publisher-dev-pass" };
const unity = { name: "unity", password: "unity-dev-pass" };
const registry = await startVerdaccio(dir, [publisher, unity], { port, logLevel: "http" });

console.log(`\n[registry] ${registry.url} (データ: ${dir})`);
console.log(`[registry] REGISTRY_URL=${registry.url}`);
console.log(`[registry] REGISTRY_TOKEN=${await loginForToken(registry.url, publisher)}   # publisher(publish 用)`);
console.log(`[registry] Unity 用(読み取り専用)のトークン: ${await loginForToken(registry.url, unity)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void registry.close().then(() => process.exit(0));
  });
}
