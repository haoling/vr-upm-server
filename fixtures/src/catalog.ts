/**
 * `pnpm fixtures` で fixtures/out/ に書き出す合成 unitypackage の一覧。
 * 実際の BOOTH アセットは入れない(DESIGN.md 6章)。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TarEntry } from "./tar.js";
import { fixtureGuid, unitypackageEntries, writeUnitypackageFile } from "./unitypackage.js";

export interface FixtureDefinition {
  name: string;
  description: string;
  /** 解析が止まるべき fixture は、期待するエラーコード(`UnitypackageAnalysisError.code`) */
  expectedError?: string;
  write(file: string): Promise<void>;
}

function fromEntries(entries: TarEntry[]) {
  return (file: string) => writeUnitypackageFile(file, entries);
}

const simpleEntries = unitypackageEntries([
  { pathname: "Assets/DummyShop/DummyItem/Models/body.fbx", content: "dummy fbx" },
  { pathname: "Assets/DummyShop/DummyItem/Textures/body.png", content: new Uint8Array(16), preview: true },
  { pathname: "Assets/DummyShop/DummyItem/Prefabs/item.prefab", content: "%YAML 1.1\n" },
]);

export const fixtures: FixtureDefinition[] = [
  {
    name: "simple",
    description: "フォルダ .meta を含まない、よくある形の unitypackage",
    write: fromEntries(simpleEntries),
  },
  {
    name: "bundled-liltoon",
    description: "lilToon 風のディレクトリを同梱している",
    write: fromEntries(
      unitypackageEntries([
        { pathname: "Assets/DummyShop/DummyItem/Models/body.fbx", content: "dummy fbx" },
        { pathname: "Assets/lilToon/Shader/lts.shader", content: "// dummy lilToon-like shader" },
      ]),
    ),
  },
  {
    name: "with-issues",
    description: "一部のフォルダ .meta あり、guid 不一致・GUID 重複・.meta 欠落・想定外エントリを含む",
    write: fromEntries(
      unitypackageEntries(
        [
          { pathname: "Assets/DummyShop" },
          { pathname: "Assets/DummyShop/DummyItem" },
          { pathname: "Assets/DummyShop/DummyItem/Models/body.fbx", content: "dummy fbx" },
          // .meta の guid がディレクトリ名と違い、しかも body.fbx と同じ guid になっている
          {
            pathname: "Assets/DummyShop/DummyItem/Models/body_copy.fbx",
            content: "dummy fbx",
            metaGuid: fixtureGuid("Assets/DummyShop/DummyItem/Models/body.fbx"),
          },
          { pathname: "Assets/DummyShop/DummyItem/Textures/no_meta.png", content: new Uint8Array(4), meta: null },
          { pathname: "Packages/com.example.dummy/Runtime/a.cs", content: "// dummy" },
        ],
        [{ path: "README.txt", body: "not part of unitypackage" }],
      ),
    ),
  },
  {
    name: "traversal",
    description: "pathname に `..` を含む(パストラバーサル)",
    expectedError: "unsafe-path",
    write: fromEntries(
      unitypackageEntries([
        { pathname: "Assets/DummyShop/ok.txt", content: "ok" },
        { pathname: "Assets/../../evil.txt", content: "evil" },
      ]),
    ),
  },
  {
    name: "tar-traversal",
    description: "tar のエントリパス自体に `..` を含む",
    expectedError: "unsafe-path",
    write: fromEntries([{ path: "../evil/asset", body: "evil" }]),
  },
  {
    name: "symlink",
    description: "シンボリックリンクのエントリを含む",
    expectedError: "unsupported-entry-type",
    write: fromEntries([{ path: `${fixtureGuid("link")}/asset`, type: "symlink", linkpath: "/etc/passwd" }]),
  },
  {
    name: "bomb",
    description: "展開すると 256 MiB のゼロになる(gzip bomb)",
    expectedError: "compression-ratio-exceeded",
    write: fromEntries(unitypackageEntries([{ pathname: "Assets/Bomb/zero.bin", content: { zeroBytes: 256 * 1024 * 1024 } }])),
  },
  {
    name: "corrupt",
    description: "simple を途中で切った壊れた tar.gz",
    expectedError: "corrupt-archive",
    async write(file) {
      await writeUnitypackageFile(file, simpleEntries);
      const bytes = await readFile(file);
      await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    },
  },
];

/** すべての fixture を `outDir/<name>.unitypackage` に書き出す */
export async function generateFixtures(outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const fixture of fixtures) {
    const file = join(outDir, `${fixture.name}.unitypackage`);
    await fixture.write(file);
    files.push(file);
  }
  return files;
}
