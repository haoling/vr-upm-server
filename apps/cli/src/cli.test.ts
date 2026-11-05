import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures, generateFixtures } from "@vr-upm/fixtures";
import { AnalysisResult } from "@vr-upm/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import { parseBytes } from "./format.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vr-upm-cli-test-"));
  await generateFixtures(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runIn(cwd: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd,
  });
  return { code, stdout, stderr };
}

const runCli = (...argv: string[]) => runIn(dir, ...argv);

describe("vr-upm analyze", () => {
  describe.each(fixtures.filter((f) => !f.expectedError).map((f) => [f.name]))("%s", (name) => {
    it("ツリーと .meta が無いフォルダを表示する", async () => {
      const r = await runCli("analyze", `${name}.unitypackage`);
      expect(r).toMatchObject({ code: 0, stderr: "" });
      expect(r.stdout).toMatchSnapshot();
    });

    it("--json で AnalysisResult を出す", async () => {
      const r = await runCli("analyze", join(dir, `${name}.unitypackage`), "--json");
      expect(r.code).toBe(0);
      const parsed = AnalysisResult.parse(JSON.parse(r.stdout));
      expect(parsed.assets.length).toBeGreaterThan(0);
    });
  });

  it.each(fixtures.filter((f) => f.expectedError).map((f) => [f.name, f.expectedError]))(
    "異常系 %s は [%s] で止まり、何も出力しない",
    async (name, code) => {
      const r = await runCli("analyze", `${name}.unitypackage`);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`[${code}]`);
      expect(r.stderr).toMatchSnapshot();
    },
  );

  it("上限をオプションで変えられる", async () => {
    const r = await runCli("analyze", "simple.unitypackage", "--max-extracted", "1KiB");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[extracted-too-large]");
  });

  it("存在しないファイル", async () => {
    const r = await runCli("analyze", "nope.unitypackage");
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.stderr).toContain("ENOENT");
  });

  it.each([[[]], [["unknown"]], [["analyze"]], [["analyze", "a", "b"]], [["analyze", "a", "--max-input", "lots"]], [["--nope"]]])(
    "引数の誤り %j は終了コード 2",
    async (argv) => {
      const r = await runCli(...argv);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
    },
  );

  it("--help", async () => {
    const r = await runCli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("vr-upm analyze <file>");
    expect(r.stdout).toContain("vr-upm build <file> --config <json>");
  });
});

const CONFIG = {
  packageName: "com.example.shop.item",
  displayName: "Dummy Item",
  version: "1.2.3",
  sourceVersionLabel: "Ver.1.2",
  rootPath: "Assets/DummyShop/DummyItem",
  exclude: ["Textures/**"],
  boothUrl: "https://example.booth.pm/items/1",
};

describe("vr-upm build", () => {
  let n = 0;

  /** テストごとに空の作業ディレクトリ(cwd)を作り、変換設定を config.json として置く */
  async function workdir(config: object | string = CONFIG): Promise<string> {
    const cwd = join(dir, `build-${n++}`);
    await mkdir(cwd);
    await writeFile(join(cwd, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
    return cwd;
  }

  const SIMPLE = () => join(dir, "simple.unitypackage");
  const tarList = (file: string) => execFileSync("tar", ["tzf", file], { encoding: "utf8" }).trim().split("\n");
  const tarRead = (file: string, path: string) => execFileSync("tar", ["xzOf", file, path], { encoding: "utf8" });

  it("--dry-run はファイル一覧とサイズを表示し、何も書き出さない", async () => {
    const cwd = await workdir();
    const r = await runIn(cwd, "build", SIMPLE(), "--config", "config.json", "--dry-run");
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(r.stdout).toMatchSnapshot();
    expect(await readdir(cwd)).toEqual(["config.json"]);
  });

  it("--dry-run --json は機械可読なレポートを出す", async () => {
    const cwd = await workdir();
    const r = await runIn(cwd, "build", SIMPLE(), "--config", "config.json", "--dry-run", "--json");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ dryRun: true, integrity: null, out: null, packageName: "com.example.shop.item", version: "1.2.3" });
    expect(report.files.map((f: { path: string }) => f.path)).toContain("Models/body.fbx");
    expect(report.excluded).toEqual(["Textures/body.png"]);
  });

  it("tgz を作る。package/ 配下の構造で、tar tzf で中身を確認できる", async () => {
    const cwd = await workdir();
    const r = await runIn(cwd, "build", SIMPLE(), "--config", "config.json", "--out", "item.tgz");
    expect(r).toMatchObject({ code: 0, stderr: "" });
    const tgz = join(cwd, "item.tgz");
    expect(tarList(tgz)).toEqual([
      "package/package.json",
      "package/package.json.meta",
      "package/Models.meta",
      "package/Models/body.fbx",
      "package/Models/body.fbx.meta",
      "package/Prefabs.meta",
      "package/Prefabs/item.prefab",
      "package/Prefabs/item.prefab.meta",
    ]);
    expect(JSON.parse(tarRead(tgz, "package/package.json"))).toMatchObject({
      name: "com.example.shop.item",
      version: "1.2.3",
      vrUpm: { source: { fileName: "simple.unitypackage", versionLabel: "Ver.1.2", rootPath: CONFIG.rootPath } },
    });
    expect(tarRead(tgz, "package/Models/body.fbx")).toBe("dummy fbx");
    // 一時ファイルを残さない
    expect(await readdir(cwd)).toEqual(["config.json", "item.tgz"]);
  });

  it("README の例(fixtures/configs/simple.json)で、リポジトリのルートからビルドできる", async () => {
    const root = join(import.meta.dirname, "../../..");
    const cwd = await workdir();
    const r = await runIn(root, "build", SIMPLE(), "--config", "fixtures/configs/simple.json", "--out", join(cwd, "readme.tgz"));
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(tarList(join(cwd, "readme.tgz"))).toContain("package/Models/body.fbx");
  });

  it("--out を省略すると ./<packageName>-<version>.tgz に書く", async () => {
    const cwd = await workdir();
    const r = await runIn(cwd, "build", SIMPLE(), "--config", "config.json");
    expect(r.code).toBe(0);
    expect(await readdir(cwd)).toContain("com.example.shop.item-1.2.3.tgz");
  });

  it("同じ入力から 2 回ビルドすると、tgz も integrity も一致する(出力の integrity は tgz の sha512)", async () => {
    const run1 = async () => {
      const cwd = await workdir();
      const r = await runIn(cwd, "build", SIMPLE(), "--config", "config.json", "--out", "a.tgz", "--json");
      expect(r.code).toBe(0);
      return { report: JSON.parse(r.stdout), bytes: await readFile(join(cwd, "a.tgz")) };
    };
    const a = await run1();
    const b = await run1();
    expect(a.report.integrity).toBe(`sha512-${createHash("sha512").update(a.bytes).digest("base64")}`);
    expect(b.report.integrity).toBe(a.report.integrity);
    expect(b.report.shasum).toBe(a.report.shasum);
    expect(b.bytes.equals(a.bytes)).toBe(true);
  });

  it("除外ルールを変えると中身も integrity も変わる", async () => {
    const withExclude = await workdir();
    const without = await workdir({ ...CONFIG, exclude: [] });
    const a = JSON.parse((await runIn(withExclude, "build", SIMPLE(), "--config", "config.json", "--out", "a.tgz", "--json")).stdout);
    const b = JSON.parse((await runIn(without, "build", SIMPLE(), "--config", "config.json", "--out", "a.tgz", "--json")).stdout);
    expect(a.integrity).not.toBe(b.integrity);
    expect(tarList(join(without, "a.tgz"))).toContain("package/Textures/body.png");
    expect(tarList(join(withExclude, "a.tgz"))).not.toContain("package/Textures/body.png");
  });

  it("変換できない設定(ルートが無い)はエラーで、tgz を作らない", async () => {
    const cwd = await workdir({ ...CONFIG, rootPath: "Assets/Nothing" });
    const r = await runIn(cwd, "build", SIMPLE(), "--config", "config.json");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("[root-not-found]");
    expect(r.stderr).toContain("tarball は作りませんでした");
    expect(await readdir(cwd)).toEqual(["config.json"]);
  });

  it("GUID が重複するパッケージはエラーで止まる", async () => {
    const cwd = await workdir();
    const r = await runIn(cwd, "build", join(dir, "with-issues.unitypackage"), "--config", "config.json");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("[duplicate-guid]");
    expect(await readdir(cwd)).toEqual(["config.json"]);
  });

  it.each(fixtures.filter((f) => f.expectedError).map((f) => [f.name, f.expectedError]))(
    "異常系 %s は [%s] で止まり、tgz を作らない",
    async (name, code) => {
      const cwd = await workdir();
      const r = await runIn(cwd, "build", join(dir, `${name}.unitypackage`), "--config", "config.json");
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`[${code}]`);
      expect(await readdir(cwd)).toEqual(["config.json"]);
    },
  );

  it("存在しない入力ファイル", async () => {
    const cwd = await workdir();
    const r = await runIn(cwd, "build", "nope.unitypackage", "--config", "config.json");
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.stderr).toContain("ENOENT");
  });

  it.each([
    ["JSON ではない", "{ nope"],
    ["必須項目がない", JSON.stringify({ packageName: "com.example.x" })],
    ["パッケージ名が不正", JSON.stringify({ ...CONFIG, packageName: "Com.Example" })],
    ["version が semver ではない", JSON.stringify({ ...CONFIG, version: "1.0" })],
    ["rootPath に ..", JSON.stringify({ ...CONFIG, rootPath: "Assets/../x" })],
  ])("設定ファイルの誤り(%s)は終了コード 2", async (_label, config) => {
    const cwd = await workdir(config);
    const r = await runIn(cwd, "build", SIMPLE(), "--config", "config.json");
    expect(r).toMatchObject({ code: 2, stdout: "" });
    expect(r.stderr).toContain("config.json");
  });

  it("設定ファイルが無ければ終了コード 2", async () => {
    const cwd = await workdir();
    const r = await runIn(cwd, "build", SIMPLE(), "--config", "missing.json");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ENOENT");
  });

  it.each([
    [["build", "a.unitypackage"]],
    [["build", "--config", "c.json"]],
    [["analyze", "a.unitypackage", "--dry-run"]],
    [["analyze", "a.unitypackage", "--config", "c.json"]],
  ])("引数の誤り %j は終了コード 2", async (argv) => {
    const r = await runCli(...argv);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });
});

describe("parseBytes", () => {
  it.each([
    ["1024", 1024],
    ["512KiB", 512 * 1024],
    ["64M", 64 * 1024 ** 2],
    ["4GiB", 4 * 1024 ** 3],
    ["1.5k", 1536],
    ["10b", 10],
  ])("%s", (text, bytes) => {
    expect(parseBytes(text)).toBe(bytes);
  });
});
