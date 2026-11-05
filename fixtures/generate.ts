/**
 * テスト用の合成 unitypackage を fixtures/out/ に生成する(`pnpm fixtures`)。
 * 中身は src/catalog.ts を参照。
 */
import { fileURLToPath } from "node:url";
import { fixtures, generateFixtures } from "./src/index.js";

const outDir = fileURLToPath(new URL("./out/", import.meta.url));
await generateFixtures(outDir);
for (const f of fixtures) {
  console.log(`${f.name}.unitypackage${f.expectedError ? ` (異常系: ${f.expectedError})` : ""} - ${f.description}`);
}
console.log(`fixtures written to ${outDir}`);
