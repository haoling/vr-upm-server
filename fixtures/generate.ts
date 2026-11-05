/**
 * テスト用の合成 unitypackage を fixtures/out/ に生成する。
 *
 * unitypackage は tar.gz で、各アセットが `<guid>/asset`, `<guid>/asset.meta`, `<guid>/pathname`
 * を持つ。ここではフォルダ .meta を含めない(実物の unitypackage でよくある形)ことで、
 * 欠落フォルダ .meta の生成処理をテストできるようにしている。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";

interface FixtureAsset {
  pathname: string;
  content: string | Buffer;
}

function guidFor(seed: string): string {
  return createHash("md5").update(seed).digest("hex");
}

function meta(guid: string): string {
  return `fileFormatVersion: 2\nguid: ${guid}\nDefaultImporter:\n  externalObjects: {}\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`;
}

async function writeUnitypackage(outFile: string, assets: FixtureAsset[]) {
  const work = mkdtempSync(join(tmpdir(), "vr-upm-fixture-"));
  try {
    const entries: string[] = [];
    for (const asset of assets) {
      const guid = guidFor(asset.pathname);
      const dir = join(work, guid);
      mkdirSync(dir);
      writeFileSync(join(dir, "asset"), asset.content);
      writeFileSync(join(dir, "asset.meta"), meta(guid));
      writeFileSync(join(dir, "pathname"), asset.pathname);
      entries.push(guid);
    }
    // 決定的な出力にするため、エントリ順と mtime を固定する
    entries.sort();
    await create(
      { gzip: true, file: outFile, cwd: work, portable: true, mtime: new Date(0) },
      entries,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const outDir = new URL("./out/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

await writeUnitypackage(join(outDir, "simple.unitypackage"), [
  { pathname: "Assets/DummyShop/DummyItem/Models/body.fbx", content: "dummy fbx" },
  { pathname: "Assets/DummyShop/DummyItem/Textures/body.png", content: Buffer.alloc(16) },
  { pathname: "Assets/DummyShop/DummyItem/Prefabs/item.prefab", content: "%YAML 1.1\n" },
]);

await writeUnitypackage(join(outDir, "bundled-liltoon.unitypackage"), [
  { pathname: "Assets/DummyShop/DummyItem/Models/body.fbx", content: "dummy fbx" },
  { pathname: "Assets/lilToon/Shader/lts.shader", content: "// dummy lilToon-like shader" },
]);

console.log(`fixtures written to ${outDir}`);
