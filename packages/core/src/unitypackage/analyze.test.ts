import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { buildUnitypackage, fixtureGuid, fixtureMeta, type TarEntry, tarChunks, unitypackageEntries } from "@vr-upm/fixtures";
import { AnalysisResult } from "@vr-upm/shared";
import { describe, expect, it } from "vitest";
import { analyzeUnitypackage, parseMetaGuid } from "./analyze.js";
import { UnitypackageAnalysisError, type UnitypackageErrorCode } from "./errors.js";
import { buildFileTree } from "./tree.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function expectFatal(promise: Promise<unknown>, code: UnitypackageErrorCode) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UnitypackageAnalysisError);
  expect((err as UnitypackageAnalysisError).code).toBe(code);
}

describe("analyzeUnitypackage: 正常系", () => {
  const input = buildUnitypackage(
    unitypackageEntries([
      { pathname: "Assets/Shop/Item/Models/body.fbx", content: "fbx" },
      { pathname: "Assets/Shop/Item/Textures/body.png", content: "png", preview: true },
      { pathname: "Assets/Shop/Item" },
      { pathname: "Packages/com.example.pkg/Runtime/a.cs", content: "cs" },
    ]),
  );

  it("アセット・フォルダ・欠落フォルダ .meta を返し、スキーマに合う", async () => {
    const result = await analyzeUnitypackage(input);
    expect(AnalysisResult.parse(result)).toEqual(result);

    expect(result.assets).toEqual([
      {
        guid: fixtureGuid("Assets/Shop/Item"),
        pathname: "Assets/Shop/Item",
        kind: "folder",
        size: null,
        sha256: null,
        metaGuid: fixtureGuid("Assets/Shop/Item"),
        hasPreview: false,
      },
      {
        guid: fixtureGuid("Assets/Shop/Item/Models/body.fbx"),
        pathname: "Assets/Shop/Item/Models/body.fbx",
        kind: "file",
        size: 3,
        sha256: sha256("fbx"),
        metaGuid: fixtureGuid("Assets/Shop/Item/Models/body.fbx"),
        hasPreview: false,
      },
      expect.objectContaining({ pathname: "Assets/Shop/Item/Textures/body.png", hasPreview: true }),
      expect.objectContaining({ pathname: "Packages/com.example.pkg/Runtime/a.cs", kind: "file" }),
    ]);
    // Assets と Packages/<name> は .meta を持たないので含めない
    expect(result.missingFolderMetas).toEqual([
      "Assets/Shop",
      "Assets/Shop/Item/Models",
      "Assets/Shop/Item/Textures",
      "Packages/com.example.pkg/Runtime",
    ]);
    expect(result.issues).toEqual([]);
    expect(result.stats).toMatchObject({
      compressedBytes: input.length,
      fileCount: 3,
      folderCount: 1,
      totalAssetBytes: 8,
    });
    // ディレクトリ 4 + ファイル 3 × (asset, asset.meta, pathname) + フォルダの (asset.meta, pathname) + preview.png
    expect(result.stats.entryCount).toBe(4 + 3 * 3 + 2 + 1);
  });

  it("小さなチャンクのストリームでも同じ結果になる", async () => {
    const whole = await analyzeUnitypackage(input);
    async function* chunks() {
      for (let i = 0; i < input.length; i += 7) yield input.subarray(i, i + 7);
    }
    expect(await analyzeUnitypackage(chunks())).toEqual(whole);
  });

  it("`./` 始まりのエントリパスと pathname の 2 行目以降を扱える", async () => {
    const guid = fixtureGuid("x");
    const result = await analyzeUnitypackage(
      buildUnitypackage([
        { path: `./${guid}/`, type: "directory" },
        { path: `./${guid}/asset`, body: "x" },
        { path: `./${guid}/asset.meta`, body: fixtureMeta(guid) },
        { path: `./${guid}/pathname`, body: "Assets/x.txt\n00\n" },
      ]),
    );
    expect(result.assets.map((a) => a.pathname)).toEqual(["Assets/x.txt"]);
    expect(result.issues).toEqual([]);
  });
});

describe("analyzeUnitypackage: issues に入る問題", () => {
  async function issueCodes(entries: TarEntry[]) {
    const result = await analyzeUnitypackage(buildUnitypackage(entries));
    return result.issues.map((i) => `${i.severity}:${i.code}`);
  }

  it(".meta の guid 不一致と、それによる GUID 重複", async () => {
    const codes = await issueCodes(
      unitypackageEntries([
        { pathname: "Assets/a.txt", content: "a" },
        { pathname: "Assets/b.txt", content: "b", metaGuid: fixtureGuid("Assets/a.txt") },
      ]),
    );
    expect(codes).toEqual(["error:duplicate-guid", "warning:meta-guid-mismatch"]);
  });

  it(".meta が無い・guid が読めない", async () => {
    const codes = await issueCodes(
      unitypackageEntries([
        { pathname: "Assets/a.txt", content: "a", meta: null },
        { pathname: "Assets/b.txt", content: "b", meta: "fileFormatVersion: 2\n" },
      ]),
    );
    expect(codes).toEqual(["warning:missing-meta", "warning:missing-meta"]);
  });

  it("pathname が無いエントリは無視する", async () => {
    const guid = fixtureGuid("orphan");
    const result = await analyzeUnitypackage(
      buildUnitypackage([
        { path: `${guid}/asset`, body: "x" },
        { path: `${guid}/asset.meta`, body: fixtureMeta(guid) },
      ]),
    );
    expect(result.assets).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(["missing-pathname"]);
  });

  it("GUID 形式でないディレクトリ名・想定外のエントリ・重複エントリ", async () => {
    const guid = fixtureGuid("a");
    const codes = await issueCodes([
      { path: "not-a-guid/asset", body: "x" },
      { path: "not-a-guid/asset.meta", body: fixtureMeta(fixtureGuid("z")) },
      { path: "not-a-guid/pathname", body: "Assets/z.txt" },
      { path: `${guid}/asset`, body: "a" },
      { path: `${guid}/asset`, body: "a2" },
      { path: `${guid}/asset.meta`, body: fixtureMeta(guid) },
      { path: `${guid}/pathname`, body: "Assets/a.txt" },
      { path: `${guid}/extra.bin`, body: "?" },
      { path: "root.txt", body: "?" },
    ]);
    expect(codes).toEqual([
      "warning:duplicate-entry",
      "warning:invalid-guid",
      "warning:meta-guid-mismatch",
      "warning:unexpected-entry",
      "warning:unexpected-entry",
    ]);
  });

  it("大文字小文字違いのパス重複と、ファイルの下にあるアセット", async () => {
    const codes = await issueCodes(
      unitypackageEntries([
        { pathname: "Assets/A.txt", content: "a" },
        { pathname: "Assets/a.txt", content: "a" },
        { pathname: "Assets/file", content: "f" },
        { pathname: "Assets/file/child.txt", content: "c" },
      ]),
    );
    expect(codes).toEqual(["error:duplicate-pathname", "error:file-folder-conflict"]);
  });
});

describe("analyzeUnitypackage: 解析を止める入力", () => {
  it.each([["Assets/../../evil.txt"], ["/etc/passwd"], ["C:/Windows/evil.txt"], [""]])(
    "危険な pathname %j",
    async (pathname) => {
      await expectFatal(analyzeUnitypackage(buildUnitypackage(unitypackageEntries([{ pathname, content: "x" }]))), "unsafe-path");
    },
  );

  it.each([["../evil/asset"], ["/abs/asset"], ["a/../../asset"]])("危険な tar エントリパス %j", async (path) => {
    await expectFatal(analyzeUnitypackage(buildUnitypackage([{ path, body: "x" }])), "unsafe-path");
  });

  it("シンボリックリンク", async () => {
    await expectFatal(
      analyzeUnitypackage(buildUnitypackage([{ path: `${fixtureGuid("l")}/asset`, type: "symlink", linkpath: "/etc/passwd" }])),
      "unsupported-entry-type",
    );
  });

  it("入力サイズの上限", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: "Assets/a.txt", content: "a" }]));
    await expectFatal(analyzeUnitypackage(input, { limits: { maxInputBytes: input.length - 1 } }), "input-too-large");
    await expect(analyzeUnitypackage(input, { limits: { maxInputBytes: input.length } })).resolves.toBeDefined();
  });

  it("展開後サイズの上限", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: "Assets/a.bin", content: { zeroBytes: 1024 * 1024 } }]));
    await expectFatal(analyzeUnitypackage(input, { limits: { maxExtractedBytes: 512 * 1024 } }), "extracted-too-large");
  });

  it("圧縮率の上限(gzip bomb)", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: "Assets/a.bin", content: { zeroBytes: 8 * 1024 * 1024 } }]));
    await expectFatal(
      analyzeUnitypackage(input, { limits: { compressionRatioSlackBytes: 1024 * 1024 } }),
      "compression-ratio-exceeded",
    );
    // 判定を始めるまでの余裕(slack)以内なら通す
    await expect(analyzeUnitypackage(input)).resolves.toBeDefined();
  });

  it("エントリ数の上限", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: "Assets/a.txt", content: "a" }]));
    await expectFatal(analyzeUnitypackage(input, { limits: { maxEntries: 3 } }), "too-many-entries");
    await expect(analyzeUnitypackage(input, { limits: { maxEntries: 4 } })).resolves.toBeDefined();
  });

  it("pathname・asset.meta の大きさの上限", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: "Assets/a.txt", content: "a" }]));
    await expectFatal(analyzeUnitypackage(input, { limits: { maxPathnameBytes: 4 } }), "entry-too-large");
    await expectFatal(analyzeUnitypackage(input, { limits: { maxMetaBytes: 16 } }), "entry-too-large");
  });

  it.each([
    ["gzip でない", Buffer.from("not a gzip at all")],
    ["空", Buffer.alloc(0)],
    ["途中で切れた gzip", buildUnitypackage(unitypackageEntries([{ pathname: "Assets/a.txt", content: "a" }])).subarray(0, 40)],
    ["tar でない中身", gzipSync(Buffer.alloc(2048, 0x41))],
    ["二重圧縮", gzipSync(buildUnitypackage(unitypackageEntries([{ pathname: "Assets/a.txt", content: "a" }])))],
    ["中身が空", gzipSync(Buffer.alloc(0))],
  ])("壊れた入力: %s", async (_label, input) => {
    await expectFatal(analyzeUnitypackage(input), "corrupt-archive");
  });

  it("tar が途中で切れている", async () => {
    const tar = Buffer.concat([...tarChunks(unitypackageEntries([{ pathname: "Assets/a.txt", content: "a".repeat(2000) }]))]);
    await expectFatal(analyzeUnitypackage(gzipSync(tar.subarray(0, 1024))), "corrupt-archive");
  });
});

describe("parseMetaGuid", () => {
  it("guid 行を読む", () => {
    expect(parseMetaGuid("fileFormatVersion: 2\nguid: ABCDEF0123456789abcdef0123456789\n")).toBe(
      "abcdef0123456789abcdef0123456789",
    );
    expect(parseMetaGuid("fileFormatVersion: 2\r\nguid: abcdef0123456789abcdef0123456789\r\n")).toBe(
      "abcdef0123456789abcdef0123456789",
    );
    expect(parseMetaGuid("fileFormatVersion: 2\n  guid: abcdef0123456789abcdef0123456789\n")).toBeNull();
    expect(parseMetaGuid("guid: short\n")).toBeNull();
  });
});

describe("buildFileTree", () => {
  it("暗黙のフォルダを補い、.meta 欠落を印付けし、名前順に並べる", async () => {
    const result = await analyzeUnitypackage(
      buildUnitypackage(
        unitypackageEntries([
          { pathname: "Assets/Shop/b.txt", content: "bb" },
          { pathname: "Assets/Shop/a/x.txt", content: "x" },
          { pathname: "Assets/Shop" },
        ]),
      ),
    );
    const simplify = (n: ReturnType<typeof buildFileTree>): unknown => ({
      name: n.name,
      ...(n.kind === "file" ? { size: n.size } : { missingMeta: n.missingMeta, hasGuid: n.guid !== null }),
      ...(n.children.length ? { children: n.children.map(simplify) } : {}),
    });
    expect(simplify(buildFileTree(result))).toEqual({
      name: "",
      missingMeta: false,
      hasGuid: false,
      children: [
        {
          name: "Assets",
          missingMeta: false,
          hasGuid: false,
          children: [
            {
              name: "Shop",
              missingMeta: false,
              hasGuid: true,
              children: [
                { name: "a", missingMeta: true, hasGuid: false, children: [{ name: "x.txt", size: 1 }] },
                { name: "b.txt", size: 2 },
              ],
            },
          ],
        },
      ],
    });
  });
});
