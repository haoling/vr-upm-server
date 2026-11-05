import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { buildUnitypackage, fixtureGuid, fixtureMeta, unitypackageEntries } from "@vr-upm/fixtures";
import { describe, expect, it } from "vitest";
import { deterministicFolderGuid } from "../guid.js";
import { inspectUnitypackage } from "../unitypackage/analyze.js";
import { packTarball, UpmPlanError } from "./pack.js";
import { planUpm } from "./plan.js";
import { convert, makeConfig, readTgz, SOURCE } from "./test-helpers.js";

const ROOT = "Assets/DummyShop/DummyItem";

const basicAssets = [
  { pathname: `${ROOT}/Models/body.fbx`, content: "dummy fbx" },
  { pathname: `${ROOT}/Textures/body.png`, content: new Uint8Array(16) },
  { pathname: `${ROOT}/Prefabs/item.prefab`, content: "%YAML 1.1\n" },
  { pathname: "Assets/Other/outside.txt", content: "outside" },
];

describe("planUpm: ルート剥がし・除外", () => {
  it("ルートのプレフィックスを剥がし、ルートの外は取り込まない", async () => {
    const { plan } = await convert(basicAssets);
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain("Models/body.fbx");
    expect(paths.some((p) => p.includes("DummyShop") || p.includes("outside"))).toBe(false);
    expect(plan.outsideRootCount).toBe(1);
    expect(plan.errors).toEqual([]);
  });

  it("パスはコード単位順で、package.json → package.json.meta が先頭", async () => {
    const { plan } = await convert(basicAssets);
    expect(plan.files.map((f) => f.path)).toEqual([
      "package.json",
      "package.json.meta",
      "Models.meta",
      "Models/body.fbx",
      "Models/body.fbx.meta",
      "Prefabs.meta",
      "Prefabs/item.prefab",
      "Prefabs/item.prefab.meta",
      "Textures.meta",
      "Textures/body.png",
      "Textures/body.png.meta",
    ]);
  });

  it("除外 glob に一致するファイルと、一致したフォルダの下をすべて外す(.meta も)", async () => {
    const { plan } = await convert(basicAssets, makeConfig({ exclude: ["Textures", "**/*.prefab"] }));
    const paths = plan.files.map((f) => f.path);
    expect(paths.filter((p) => p.startsWith("Textures") || p.startsWith("Prefabs/item"))).toEqual([]);
    expect(paths).toContain("Models/body.fbx");
    expect(plan.excluded).toEqual(["Prefabs/item.prefab", "Textures/body.png"]);
  });

  it("ドットファイルも glob の対象になる", async () => {
    const { plan } = await convert(
      [...basicAssets, { pathname: `${ROOT}/.hidden/x.txt`, content: "x" }],
      makeConfig({ exclude: [".hidden"] }),
    );
    expect(plan.files.some((f) => f.path.startsWith(".hidden"))).toBe(false);
  });

  it("ルートの下に何も無ければ root-not-found", async () => {
    const { plan, tgz } = await convert(basicAssets, makeConfig({ rootPath: "Assets/Nope" }));
    expect(plan.errors.map((e) => e.code)).toEqual(["root-not-found"]);
    expect(tgz).toBeNull();
  });

  it("すべて除外すると no-files", async () => {
    const { plan } = await convert(basicAssets, makeConfig({ exclude: ["**"] }));
    expect(plan.errors.map((e) => e.code)).toEqual(["no-files"]);
  });

  it("rootPath の前後の / や \\ は正規化される", () => {
    expect(makeConfig({ rootPath: "/Assets\\DummyShop\\DummyItem/" }).rootPath).toBe(ROOT);
  });
});

describe("planUpm: .meta", () => {
  it("欠けているフォルダ .meta を deterministicFolderGuid で作り、元の .meta はそのまま維持する", async () => {
    const existing = fixtureMeta("0123456789abcdef0123456789abcdef", true).replace("folderAsset: yes", "folderAsset: yes\n# kept");
    const { plan } = await convert([
      { pathname: `${ROOT}/Models`, guid: "0123456789abcdef0123456789abcdef", meta: existing },
      { pathname: `${ROOT}/Models/body.fbx`, content: "x", meta: fixtureMeta("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") },
      { pathname: `${ROOT}/Textures/Sub/body.png`, content: "y" },
    ]);
    const byPath = new Map(plan.files.map((f) => [f.path, f]));

    // 元の .meta はバイト列ごと維持される(guid もコメントも)
    const kept = byPath.get("Models.meta");
    expect(kept?.origin).toBe("meta");
    expect(kept?.content).toEqual({ kind: "text", text: existing });
    expect(byPath.get("Models/body.fbx.meta")?.content).toEqual({
      kind: "text",
      text: fixtureMeta("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    });

    // 無かったフォルダ(暗黙の中間フォルダも)には決定的な GUID の .meta を作る
    for (const dir of ["Textures", "Textures/Sub"]) {
      const f = byPath.get(`${dir}.meta`);
      expect(f?.origin).toBe("generated-meta");
      const guid = deterministicFolderGuid("com.example.shop.item", dir);
      expect(f?.content).toEqual({
        kind: "text",
        text: `fileFormatVersion: 2\nguid: ${guid}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`,
      });
    }
    // ルートそのものの .meta は作らない
    expect(byPath.has(".meta")).toBe(false);
  });

  it("フォルダ .meta の GUID はバージョンが変わっても、元ファイルが変わっても同じ", async () => {
    const guidOf = async (version: string, extra: string) => {
      const { plan } = await convert(
        [
          { pathname: `${ROOT}/Textures/body.png`, content: extra },
          { pathname: `${ROOT}/Extra/${extra}.txt`, content: extra },
        ],
        makeConfig({ version }),
      );
      const text = plan.files.find((f) => f.path === "Textures.meta")?.content;
      return text?.kind === "text" ? /guid: (\w+)/.exec(text.text)?.[1] : undefined;
    };
    expect(await guidOf("1.0.0", "a")).toBe(await guidOf("2.3.4", "bbb"));
  });

  it("パッケージ名が違えばフォルダ GUID も変わる", async () => {
    const a = (await convert(basicAssets, makeConfig({ packageName: "com.example.a" }))).plan;
    const b = (await convert(basicAssets, makeConfig({ packageName: "com.example.b" }))).plan;
    const text = (p: typeof a) => JSON.stringify(p.files.find((f) => f.path === "Models.meta")?.content);
    expect(text(a)).not.toBe(text(b));
  });

  it("ファイルの .meta が無ければ警告(エラーにはしない)", async () => {
    const { plan } = await convert([{ pathname: `${ROOT}/a.txt`, content: "a", meta: null }]);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.map((w) => w.code)).toEqual(["missing-meta"]);
    expect(plan.files.map((f) => f.path)).not.toContain("a.txt.meta");
  });

  it("GUID が重複していればエラー", async () => {
    const dup = fixtureGuid("dup");
    const { plan, tgz } = await convert([
      { pathname: `${ROOT}/a.txt`, content: "a", metaGuid: dup },
      { pathname: `${ROOT}/b.txt`, content: "b", metaGuid: dup },
    ]);
    expect(plan.errors.map((e) => e.code)).toEqual(["duplicate-guid"]);
    expect(tgz).toBeNull();
  });

  it("package.json と同名のアセットは reserved-path", async () => {
    const { plan } = await convert([{ pathname: `${ROOT}/package.json`, content: "{}" }]);
    expect(plan.errors.map((e) => e.code)).toContain("reserved-path");
  });

  it("パスが大文字小文字違いで重複していればエラー", async () => {
    const { plan } = await convert([
      { pathname: `${ROOT}/A.txt`, content: "a" },
      { pathname: `${ROOT}/a.txt`, content: "b" },
    ]);
    expect(plan.errors.map((e) => e.code)).toContain("duplicate-path");
  });
});

describe("package.json", () => {
  it("名前・version・displayName と、元ファイル名・sha256・BOOTH URL などのメタ情報を含む", async () => {
    const { plan } = await convert(
      basicAssets,
      makeConfig({
        description: "説明",
        unity: "2022.3",
        sourceVersionLabel: "Ver.1.2.3",
        boothUrl: "https://example.booth.pm/items/1",
      }),
    );
    const file = plan.files.find((f) => f.path === "package.json");
    expect(file?.content.kind === "text" && file.content.text).toBe(
      `${JSON.stringify(
        {
          name: "com.example.shop.item",
          version: "1.0.0",
          displayName: "Dummy Item",
          description: "説明",
          unity: "2022.3",
          vrUpm: {
            source: {
              fileName: "dummy.unitypackage",
              sha256: "ab".repeat(32),
              versionLabel: "Ver.1.2.3",
              boothUrl: "https://example.booth.pm/items/1",
              rootPath: ROOT,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("任意項目を省くと、そのキーは出さない", async () => {
    const { plan } = await convert(basicAssets);
    expect(plan.packageJson).toEqual({
      name: "com.example.shop.item",
      version: "1.0.0",
      displayName: "Dummy Item",
      vrUpm: { source: { fileName: "dummy.unitypackage", sha256: "ab".repeat(32), rootPath: ROOT } },
    });
  });
});

describe("packTarball", () => {
  it("Unity が読める構造: すべて package/ の下で、メタデータが固定されている", async () => {
    const { tgz, plan } = await convert(basicAssets);
    const entries = await readTgz(tgz!);
    expect(entries.map((e) => e.path)).toEqual(plan.files.map((f) => `package/${f.path}`));
    for (const e of entries) {
      expect(e).toMatchObject({ type: "File", mode: 0o644, uid: 0, gid: 0, mtime: 499162500 * 1000 });
      expect(e.uname ?? "").toBe("");
    }
    expect(entries[0]?.path).toBe("package/package.json");
    const json = JSON.parse(entries[0]!.content);
    expect(json.name).toBe("com.example.shop.item");
    expect(entries.find((e) => e.path === "package/Models/body.fbx")?.content).toBe("dummy fbx");
  });

  it("同じ入力で 2 回ビルドすると integrity が一致する", async () => {
    const a = await convert(basicAssets);
    const b = await convert(basicAssets);
    expect(a.digest?.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(b.digest).toEqual(a.digest);
    expect(b.tgz!.equals(a.tgz!)).toBe(true);
  });

  it("integrity と shasum は tgz のバイト列から計算した値と一致する", async () => {
    const { tgz, digest } = await convert(basicAssets);
    expect(digest).toEqual({
      integrity: `sha512-${createHash("sha512").update(tgz!).digest("base64")}`,
      shasum: createHash("sha1").update(tgz!).digest("hex"),
      size: tgz!.length,
    });
  });

  it("入力・中身のチャンクの切り方が違っても同じ integrity になる", async () => {
    const whole = await convert(basicAssets);
    const small = await convert(basicAssets, makeConfig(), { inputChunk: 7, storeChunk: 3 });
    expect(small.digest).toEqual(whole.digest);
  });

  it("gzip ヘッダが固定されている(mtime = 0、OS = Unix)", async () => {
    const { tgz } = await convert(basicAssets);
    expect([...tgz!.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(tgz![9]).toBe(3);
  });

  it("入力や設定が変われば integrity も変わる", async () => {
    const base = await convert(basicAssets);
    const changedContent = await convert(basicAssets.map((a, i) => (i === 0 ? { ...a, content: "changed fbx" } : a)));
    const changedVersion = await convert(basicAssets, makeConfig({ version: "1.0.1" }));
    expect(changedContent.digest?.integrity).not.toBe(base.digest?.integrity);
    expect(changedVersion.digest?.integrity).not.toBe(base.digest?.integrity);
  });

  it("長いパス・日本語のパスも読み戻せる", async () => {
    const long = `${"とても長いフォルダ名/".repeat(8)}ファイル.txt`;
    const longAscii = `${"deep_folder_name/".repeat(12)}file.txt`;
    const { tgz } = await convert([
      { pathname: `${ROOT}/${long}`, content: "jp" },
      { pathname: `${ROOT}/${longAscii}`, content: "ascii" },
      { pathname: `${ROOT}/日本語.txt`, content: "short" },
    ]);
    const entries = await readTgz(tgz!);
    const byPath = new Map(entries.map((e) => [e.path, e.content]));
    expect(byPath.get(`package/${long}`)).toBe("jp");
    expect(byPath.get(`package/${longAscii}`)).toBe("ascii");
    expect(byPath.get("package/日本語.txt")).toBe("short");
    expect(byPath.has(`package/${long}.meta`)).toBe(true);
  });

  it("空の asset も入れられる", async () => {
    const { tgz } = await convert([{ pathname: `${ROOT}/empty.txt`, content: "" }]);
    const entries = await readTgz(tgz!);
    expect(entries.find((e) => e.path === "package/empty.txt")?.content).toBe("");
  });

  it("エラーのある計画は tarball にしない", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: "Assets/Other/a.txt", content: "a" }]));
    const { analysis, metas } = await inspectUnitypackage(input);
    const plan = planUpm(analysis, metas, makeConfig(), SOURCE);
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    await expect(packTarball(plan, { open: () => [] }, sink)).rejects.toBeInstanceOf(UpmPlanError);
  });

  it("asset の中身が見込みと違えば止まる", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: `${ROOT}/a.txt`, content: "abc" }]));
    const { analysis, metas } = await inspectUnitypackage(input);
    const plan = planUpm(analysis, metas, makeConfig(), SOURCE);
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    await expect(packTarball(plan, { open: () => [Buffer.from("ab")] }, sink)).rejects.toThrow(/expected 3 bytes/);
  });
});

describe("inspectUnitypackage の assetSink", () => {
  it("asset の中身を sink へ流し、メモリには保持しない。バックプレッシャーにも従う", async () => {
    const payload = Buffer.alloc(300_000, 7);
    const input = buildUnitypackage(unitypackageEntries([{ pathname: `${ROOT}/big.bin`, content: payload }]));
    let received = 0;
    let slowWrites = 0;
    const { analysis, metas } = await inspectUnitypackage(input, {
      assetSink: () =>
        new Writable({
          highWaterMark: 1024,
          write(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            slowWrites++;
            setImmediate(cb);
          },
        }),
    });
    expect(received).toBe(payload.length);
    expect(slowWrites).toBeGreaterThan(1);
    expect(analysis.assets[0]?.size).toBe(payload.length);
    expect(metas.size).toBe(1);
  });

  it("sink が失敗したら解析も失敗する", async () => {
    const input = buildUnitypackage(unitypackageEntries([{ pathname: `${ROOT}/a.txt`, content: "a" }]));
    await expect(
      inspectUnitypackage(input, {
        assetSink: () => new Writable({ write: (_c, _e, cb) => cb(new Error("disk full")) }),
      }),
    ).rejects.toThrow("disk full");
  });

  it("gunzip 済みの tar を直接見ても、tar の末尾は 2 ブロックのゼロ", async () => {
    const { tgz } = await convert(basicAssets);
    const tar = gunzipSync(tgz!);
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every((b) => b === 0)).toBe(true);
  });
});
